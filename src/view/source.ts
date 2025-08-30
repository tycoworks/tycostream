import { Logger } from '@nestjs/common';
import { Observable, Subject, ReplaySubject, filter, map, concat, from, finalize } from 'rxjs';
import { DatabaseStream } from '../database/stream';
import { DatabaseRowUpdateType } from '../database/types';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import type { Cache } from './cache.types';
import { SimpleCache } from './cache';
import { truncateForLog } from '../common/logging.utils';

/**
 * Represents a cached data source with streaming updates
 * Domain object that manages cache and database streaming for a single source
 * Not injectable - created and managed by SourceService
 */
export class Source {
  private readonly logger = new Logger(Source.name);
  private readonly cache: Cache;
  private readonly internalUpdates$ = new Subject<[RowUpdateEvent, bigint]>();
  private latestTimestamp = BigInt(0);
  private isShuttingDown = false;
  private activeSubscribers = 0;
  private readonly allFields: Set<string>;

  constructor(
    private readonly databaseStream: DatabaseStream,
    private readonly sourceDef: SourceDefinition,
    private readonly onDispose: () => void
  ) {
    this.cache = new SimpleCache(sourceDef.primaryKeyField);
    this.allFields = new Set(sourceDef.fields.map(f => f.name));
    
    // Start streaming immediately since we're created on-demand
    this.startStreaming().catch(error => {
      this.logger.error(`Failed to start streaming for ${this.sourceDef.name}`, error);
      // Database connection errors are unrecoverable - trigger application shutdown
      this.handleFatalError(error);
    });
  }

  /**
   * Check if this source has been disposed
   */
  get isDisposed(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Get a stream of updates with late joiner support
   * Returns unfiltered stream of all updates from this source
   */
  getUpdates(skipSnapshot = false): Observable<RowUpdateEvent> {
    if (this.isShuttingDown) {
      throw new Error('Database stream is shutting down, cannot accept new subscriptions');
    }

    // Take snapshot timestamp before any async operations
    const snapshotTimestamp = this.latestTimestamp;
    
    // Create per-client buffer and immediately start buffering live events
    const buffer$ = new ReplaySubject<RowUpdateEvent>();
    const subscription = this.internalUpdates$.pipe(
      filter(([event, timestamp]) => timestamp > snapshotTimestamp),
      map(([event]) => event)
    ).subscribe(buffer$);
    
    // Track subscriber
    this.activeSubscribers++;
    this.logger.debug(`Consumer connected - source: ${this.sourceDef.name}, cacheSize: ${this.cache.size}, subscribers: ${this.activeSubscribers}`);
    
    // Create stream with or without snapshot based on skipSnapshot
    const stream$ = skipSnapshot 
      ? buffer$ 
      : concat(
          from(this.cache.getAllRows()).pipe(
            map(row => ({
              type: RowUpdateType.Insert,
              fields: new Set(Object.keys(row)),
              row
            }))
          ),
          buffer$
        );

    return stream$.pipe(
      finalize(() => {
        this.activeSubscribers--;
        this.logger.debug(`Consumer disconnected - source: ${this.sourceDef.name}, subscribers: ${this.activeSubscribers}`);
        subscription.unsubscribe();
        buffer$.complete();
        
        // Dispose when last subscriber disconnects
        if (this.activeSubscribers === 0 && !this.isShuttingDown) {
          this.logger.log(`No more subscribers for ${this.sourceDef.name}, disposing resources`);
          // Use setTimeout to avoid disposing while still in the observable chain
          setTimeout(() => {
            if (this.activeSubscribers === 0) {
              this.dispose();
            }
          }, 0);
        }
      })
    );
  }

  /**
   * Get the primary key field for this source
   */
  getPrimaryKeyField(): string {
    return this.sourceDef.primaryKeyField;
  }



  /**
   * Start streaming from the database if not already active
   * Sets up callbacks with fail-fast error handling
   */
  private async startStreaming(): Promise<void> {
    try {
      // Connect to database and start streaming with callbacks
      await this.databaseStream.connect(
        (row: Record<string, any>, timestamp: bigint, updateType: DatabaseRowUpdateType) => {
          this.processUpdate(row, timestamp, updateType);
        },
        (error: Error) => {
          // Log runtime database errors
          this.logger.error(`Database stream error for ${this.sourceDef.name}`);
          
          // If we're shutting down, don't trigger fail-fast
          if (!this.isShuttingDown) {
            this.internalUpdates$.error(error);
            // Database connection errors are unrecoverable - trigger application shutdown
            this.handleFatalError(error);
          }
        }
      );
    } catch (error) {
      // Propagate startup database errors to all subscribers
      this.internalUpdates$.error(error);
      throw error;
    }
  }

  /**
   * Process an incoming update from the database stream
   * Core method that updates timestamp, cache, and emits events
   */
  private processUpdate(row: Record<string, any>, timestamp: bigint, updateType: DatabaseRowUpdateType): void {
    // Update timestamp tracking
    this.latestTimestamp = timestamp;
    
    // Extract primary key once
    const primaryKey = row[this.sourceDef.primaryKeyField];

    // Determine the event type and prepare data
    const event = this.prepareEvent(row, primaryKey, updateType);

    // Update cache and log the operation
    this.updateCacheAndLog(row, event.type, primaryKey, event.row);

    // Emit to internal subject
    this.internalUpdates$.next([event, timestamp]);
  }

  /**
   * Determine the appropriate event type and data based on database update type
   * Handles UPSERT logic and enriches events with cached data
   */
  private prepareEvent(row: Record<string, any>, primaryKey: any, updateType: DatabaseRowUpdateType): RowUpdateEvent {
    const existingRow = this.cache.get(primaryKey);
    
    // Enrich with cached data if available (for DELETE and partial UPDATE support)
    const fullRow = existingRow ? { ...existingRow, ...row } : row;
    
    let eventType: RowUpdateType;
    let fields: Set<string>;
    
    if (updateType === DatabaseRowUpdateType.Delete) {
      eventType = RowUpdateType.Delete;
      fields = new Set(this.allFields);  // Copy to prevent mutation
    } else if (updateType === DatabaseRowUpdateType.Upsert) {
      if (existingRow) {
        // UPDATE - calculate what changed
        eventType = RowUpdateType.Update;
        fields = new Set<string>();
        this.calculateChanges(existingRow, row, fields);
      } else {
        // INSERT - all schema fields
        eventType = RowUpdateType.Insert;
        fields = new Set(this.allFields);  // Copy to prevent mutation
      }
    } else {
      // Future-proofing for new enum values
      throw new Error(`Unexpected update type: ${updateType} for row: ${truncateForLog(row)}`);
    }
    
    return { type: eventType, fields, row: fullRow };
  }

  /**
   * Update the cache and log the operation for debugging
   * Centralizes cache updates with consistent debug logging
   */
  private updateCacheAndLog(row: Record<string, any>, eventType: RowUpdateType, primaryKey: any, logData: Record<string, any>): void {
    // Update cache and determine log action
    let action: string;
    
    if (eventType === RowUpdateType.Delete) {
      this.cache.delete(row);
      action = 'Removed from';
    } else {
      this.cache.set(row);
      action = eventType === RowUpdateType.Insert ? 'Added to' : 'Updated in';
    }
    
    this.logger.debug(`${action} cache - source: ${this.sourceDef.name}, primaryKey: ${primaryKey}, cacheSize: ${this.cache.size}, data: ${truncateForLog(logData)}`);
  }

  /**
   * Calculate field-level changes between existing and new row
   * Adds changed fields to the provided Set
   */
  private calculateChanges(existingRow: Record<string, any>, newRow: Record<string, any>, fields: Set<string>): void {
    for (const [key, value] of Object.entries(newRow)) {
      if (existingRow[key] !== value) {
        fields.add(key);
      }
    }
  }

  /**
   * Handle fatal errors by triggering graceful shutdown
   */
  private handleFatalError(error: Error): void {
    this.logger.warn(`Triggering application shutdown due to database error`);
    // Clean up this broken Source before failing
    this.dispose();
    // In NestJS, we should throw an unhandled error to trigger shutdown
    // The error will bubble up and cause the application to exit
    setTimeout(() => {
      throw error; // Throw the original error to preserve stack trace
    }, 0);
  }

  /**
   * Dispose resources when no subscribers remain
   * Clears cache and stops database subscriber
   */
  dispose(): void {
    if (this.isShuttingDown) {
      return; // Already shutting down
    }
    
    this.isShuttingDown = true;
    this.logger.log(`Disposing Source for ${this.sourceDef.name}`);
    
    // Clear the cache
    this.cache.clear();
    this.logger.debug(`Cache cleared for ${this.sourceDef.name}`);
    
    // Disconnect the database stream
    this.databaseStream.disconnect();
    this.logger.debug(`Database stream disconnected for ${this.sourceDef.name}`);
    
    // Notify parent to clean up resources
    this.onDispose();
    
    // Complete the internal updates subject
    this.internalUpdates$.complete();
  }

}