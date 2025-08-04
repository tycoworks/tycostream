import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, ReplaySubject, filter, Subscription } from 'rxjs';
import { DatabaseConnectionService } from '../database/connection.service';
import { DatabaseSubscriber } from '../database/subscriber';
import type { ProtocolHandler } from '../database/types';
import { DatabaseRowUpdateType } from '../database/types';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType, type RowUpdateEvent, type Filter } from './types';
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
  private readonly databaseSubscriber: DatabaseSubscriber;
  private latestTimestamp = BigInt(0);
  private _consumerCount = 0;
  private isShuttingDown = false;

  constructor(
    private connectionService: DatabaseConnectionService,
    private readonly sourceDef: SourceDefinition,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {
    this.cache = new SimpleCache(sourceDef.primaryKeyField);
    this.databaseSubscriber = new DatabaseSubscriber(
      connectionService,
      sourceName,
      protocolHandler
    );
  }

  /**
   * Get a stream of updates with late joiner support
   * This is the main interface that will be used by GraphQL subscriptions
   */
  getUpdates(filter?: Filter | null): Observable<RowUpdateEvent> {
    if (this.isShuttingDown) {
      throw new Error('Database subscriber is shutting down, cannot accept new subscriptions');
    }

    // Start streaming if not already started
    if (!this.databaseSubscriber.streaming && !this.isShuttingDown) {
      this.startStreaming().catch(error => {
        this.logger.error(`Failed to start streaming for ${this.sourceName}`);
        // Database connection errors are unrecoverable - trigger application shutdown
        this.handleFatalError(error);
      });
    }

    // Increment consumer count
    this._consumerCount++;

    // Create a replayable stream for this consumer
    const consumerStream$ = new ReplaySubject<RowUpdateEvent>();
    
    // Take snapshot before subscribing to avoid race condition
    const snapshotTimestamp = this.latestTimestamp;
    const snapshot = this.cache.getAllRows();
    
    // Send snapshot to consumer
    const snapshotCount = this.sendSnapshot(consumerStream$, snapshot);
    this.logger.debug(`Sending cached data to consumer - source: ${this.sourceName}, cachedRows: ${snapshotCount}, activeConsumers: ${this._consumerCount}`);
    
    // Subscribe to live updates after snapshot
    const subscription = this.subscribeToLiveUpdates(consumerStream$, snapshotTimestamp);
    
    this.logger.debug(`Consumer connected - source: ${this.sourceName}, cacheSize: ${this.cache.size}, activeConsumers: ${this._consumerCount}`);

    // Return observable that handles cleanup on unsubscribe
    return this.createCleanupObservable(consumerStream$, subscription);
  }

  /**
   * Get row count
   */
  getRowCount(): number {
    return this.cache.size;
  }

  /**
   * Check if streaming is active
   */
  get streaming(): boolean {
    return this.databaseSubscriber.streaming;
  }

  /**
   * Get consumer count for monitoring
   */
  get consumerCount(): number {
    return this._consumerCount;
  }

  /**
   * Get latest timestamp
   */
  get currentTimestamp(): bigint {
    return this.latestTimestamp;
  }


  /**
   * Cleanup on module destroy
   * Completes streams and shuts down database subscriber gracefully
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down stream...');
    this.isShuttingDown = true;
    
    // Clean up database subscriber
    await this.databaseSubscriber.onModuleDestroy();
    
    // Complete internal streams
    this.internalUpdates$.complete();
  }

  /**
   * Start streaming from the database if not already active
   * Sets up callbacks with fail-fast error handling
   */
  private async startStreaming(): Promise<void> {
    try {
      // Start database streaming with callback for updates and errors
      await this.databaseSubscriber.startStreaming(
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
    this.updateCacheAndLog(row, event.type, primaryKey, event.fields);

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
    
    // Determine event type and data
    let eventType: RowUpdateType;
    let eventData: Record<string, any>;
    
    if (updateType === DatabaseRowUpdateType.Delete) {
      eventType = RowUpdateType.Delete;
      eventData = this.getPkObject(primaryKey);
    } else if (updateType === DatabaseRowUpdateType.Upsert) {
      if (existingRow) {
        // UPDATE - start with primary key, add changes
        eventType = RowUpdateType.Update;
        eventData = this.getPkObject(primaryKey);
        this.calculateChanges(existingRow, row, eventData);
      } else {
        // INSERT - use full row
        eventType = RowUpdateType.Insert;
        eventData = row;
      }
    } else {
      // Unknown update type - this should never happen
      throw new Error(`Unexpected update type: ${updateType} for row: ${truncateForLog(row)}`);
    }
    
    return {
      type: eventType,
      fields: eventData,
      row: eventType === RowUpdateType.Delete ? existingRow : row
    };
  }

  /**
   * Create an object containing only the primary key field
   * Used for DELETE events where we only need to identify the row
   */
  private getPkObject(primaryKey: any): Record<string, any> {
    return { [this.sourceDef.primaryKeyField]: primaryKey };
  }

  /**
   * Update the cache and log the operation for debugging
   * Centralizes cache updates with consistent debug logging
   */
  private updateCacheAndLog(row: Record<string, any>, eventType: RowUpdateType, primaryKey: any, eventData: Record<string, any>): void {
    // Update cache and determine log action
    let action: string;
    
    if (eventType === RowUpdateType.Delete) {
      this.cache.delete(row);
      action = 'Removed from';
    } else {
      this.cache.set(row);
      action = eventType === RowUpdateType.Insert ? 'Added to' : 'Updated in';
    }
    
    this.logger.debug(`${action} cache - source: ${this.sourceName}, primaryKey: ${primaryKey}, cacheSize: ${this.cache.size}, data: ${truncateForLog(eventData)}`);
  }

  /**
   * Calculate field-level changes between existing and new row
   * Enables bandwidth-efficient updates by sending only changed fields
   */
  private calculateChanges(existingRow: Record<string, any>, newRow: Record<string, any>, changes: Record<string, any>): void {
    for (const [key, value] of Object.entries(newRow)) {
      if (existingRow[key] !== value) {
        changes[key] = value;
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
   * Send cached snapshot data as INSERT events to a new consumer
   * Returns count for logging/metrics
   */
  private sendSnapshot(consumerStream$: ReplaySubject<RowUpdateEvent>, snapshot: Record<string, any>[]): number {
    // Emit snapshot as insert events
    let snapshotCount = 0;
    for (const row of snapshot) {
      consumerStream$.next({
        type: RowUpdateType.Insert,
        fields: { ...row }
      });
      snapshotCount++;
    }
    
    return snapshotCount;
  }

  /**
   * Subscribe to live updates filtering by timestamp
   * Prevents duplicates by filtering events older than snapshot
   */
  private subscribeToLiveUpdates(consumerStream$: ReplaySubject<RowUpdateEvent>, snapshotTimestamp: bigint): Subscription {
    // Subscribe to future updates with timestamp filter
    return this.internalUpdates$.pipe(
      filter(([event, timestamp]) => {
        // Only emit events newer than snapshot timestamp
        return timestamp > snapshotTimestamp;
      })
    ).subscribe(([event]) => {
      // Forward the event to consumer
      consumerStream$.next(event);
    });
  }


  /**
   * Create observable with cleanup logic for graceful disconnection
   * Ensures proper cleanup: decrements count, unsubscribes, prevents leaks
   */
  private createCleanupObservable(consumerStream$: ReplaySubject<RowUpdateEvent>, subscription: Subscription): Observable<RowUpdateEvent> {
    // Return observable that handles cleanup on unsubscribe
    return new Observable<RowUpdateEvent>(subscriber => {
      const proxySubscription = consumerStream$.subscribe(subscriber);
      
      // Return teardown logic
      return () => {
        // Decrement consumer count
        this._consumerCount--;
        
        this.logger.debug(`Consumer disconnected - source: ${this.sourceName}, remainingConsumers: ${this._consumerCount}`);
        
        // Clean up subscriptions
        subscription.unsubscribe();
        proxySubscription.unsubscribe();
        consumerStream$.complete();
      };
    });
  }
}