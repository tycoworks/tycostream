import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, ReplaySubject, filter, map, concat, from, finalize } from 'rxjs';
import { DatabaseStreamService } from '../database/connection.service';
import { DatabaseStream } from '../database/subscriber';
import type { ProtocolHandler } from '../database/types';
import { DatabaseRowUpdateType } from '../database/types';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import type { Cache } from './cache.types';
import { SimpleCache } from './cache';
import { truncateForLog } from '../common/logging.utils';

/**
 * Database streaming service for a single source
 * Handles Observable-based streaming with late joiner support
 * Uses DatabaseProtocolHandler for database connection management
 */
export class StreamingService implements OnModuleDestroy {
  private readonly logger = new Logger(StreamingService.name);
  private readonly cache: Cache;
  private readonly internalUpdates$ = new Subject<[RowUpdateEvent, bigint]>();
  private readonly databaseStream: DatabaseStream;
  private latestTimestamp = BigInt(0);
  private isShuttingDown = false;
  private activeSubscribers = 0;

  constructor(
    private streamService: DatabaseStreamService,
    private readonly sourceDef: SourceDefinition,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {
    this.cache = new SimpleCache(sourceDef.primaryKeyField);
    // Get the database stream from the stream service
    this.databaseStream = streamService.getStream(sourceName, protocolHandler);
    
    // Start streaming immediately since we're created on-demand
    this.startStreaming().catch(error => {
      this.logger.error(`Failed to start streaming for ${this.sourceName}`, error);
      // Database connection errors are unrecoverable - trigger application shutdown
      this.handleFatalError(error);
    });
  }

  /**
   * Get a stream of updates with late joiner support
   * Returns unfiltered stream of all updates from this source
   */
  getUpdates(): Observable<RowUpdateEvent> {
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
    
    // Create snapshot observable from cache
    const snapshot$ = from(this.cache.getAllRows()).pipe(
      map(row => ({
        type: RowUpdateType.Insert,
        fields: new Set(Object.keys(row)),
        row
      }))
    );
    
    // Track subscriber
    this.activeSubscribers++;
    this.logger.debug(`Consumer connected - source: ${this.sourceName}, cacheSize: ${this.cache.size}, subscribers: ${this.activeSubscribers}`);
    
    // Concat: First emit all snapshot events, then emit buffered live events
    return concat(snapshot$, buffer$).pipe(
      finalize(() => {
        this.activeSubscribers--;
        this.logger.debug(`Consumer disconnected - source: ${this.sourceName}, subscribers: ${this.activeSubscribers}`);
        subscription.unsubscribe();
        buffer$.complete();
        
        // Dispose when last subscriber disconnects
        if (this.activeSubscribers === 0 && !this.isShuttingDown) {
          this.logger.log(`No more subscribers for ${this.sourceName}, disposing resources`);
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
   * Cleanup on module destroy
   * Delegates to dispose() for actual cleanup
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down stream...');
    this.dispose();
    // dispose() already calls streamService.removeStream() which disconnects the stream
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
          this.logger.error(`Database stream error for ${this.sourceName}`);
          
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
   * Handles UPSERT logic and minimizes DELETE event data
   */
  private prepareEvent(row: Record<string, any>, primaryKey: any, updateType: DatabaseRowUpdateType): RowUpdateEvent {
    // Get existing row from cache if it exists
    const existingRow = this.cache.get(primaryKey);
    
    // Determine event type and fields
    let eventType: RowUpdateType;
    let fields: Set<string>;
    let eventRow: Record<string, any>;
    
    if (updateType === DatabaseRowUpdateType.Delete) {
      eventType = RowUpdateType.Delete;
      fields = this.getPkFieldSet();
      // For DELETE, normalize row to only contain primary key
      eventRow = { [this.sourceDef.primaryKeyField]: primaryKey };
    } else if (updateType === DatabaseRowUpdateType.Upsert) {
      if (existingRow) {
        // UPDATE - start with primary key, add changed fields
        eventType = RowUpdateType.Update;
        fields = this.getPkFieldSet();
        this.calculateChanges(existingRow, row, fields);
      } else {
        // INSERT - all fields
        eventType = RowUpdateType.Insert;
        fields = new Set(Object.keys(row));
      }
      eventRow = row;
    } else {
      // Unknown update type - this should never happen
      throw new Error(`Unexpected update type: ${updateType} for row: ${truncateForLog(row)}`);
    }
    
    return {
      type: eventType,
      fields,
      row: eventRow
    };
  }

  /**
   * Create a Set containing only the primary key field
   * Used for DELETE events and as the base for UPDATE events
   */
  private getPkFieldSet(): Set<string> {
    return new Set<string>([this.sourceDef.primaryKeyField]);
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
    
    this.logger.debug(`${action} cache - source: ${this.sourceName}, primaryKey: ${primaryKey}, cacheSize: ${this.cache.size}, data: ${truncateForLog(logData)}`);
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
  private dispose(): void {
    if (this.isShuttingDown) {
      return; // Already shutting down
    }
    
    this.isShuttingDown = true;
    this.logger.log(`Disposing StreamingService for ${this.sourceName}`);
    
    // Clear the cache
    this.cache.clear();
    this.logger.debug(`Cache cleared for ${this.sourceName}`);
    
    // Notify stream service to remove the stream
    this.streamService.removeStream(this.sourceName);
    this.logger.debug(`Database stream removed for ${this.sourceName}`);
    
    // Complete the internal updates subject
    this.internalUpdates$.complete();
  }

}