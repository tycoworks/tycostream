import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, ReplaySubject, filter, Subscription, map, share } from 'rxjs';
import { DatabaseConnectionService } from '../database/connection.service';
import { DatabaseSubscriber } from '../database/subscriber';
import type { ProtocolHandler } from '../database/types';
import { DatabaseRowUpdateType } from '../database/types';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType, type RowUpdateEvent, type Filter } from './types';
import type { Cache } from './cache.types';
import { SimpleCache } from './cache';
import { truncateForLog } from '../common/logging.utils';
import { View } from './view';

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
  private readonly viewCache = new Map<string, View>();

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
  getUpdates(viewFilter: Filter): Observable<RowUpdateEvent> {
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

    // Get or create view
    const view = this.getView(viewFilter);

    // Create a replayable stream for this consumer
    const consumerStream$ = new ReplaySubject<RowUpdateEvent>();
    
    // Take snapshot before subscribing to avoid race condition
    const snapshotTimestamp = this.latestTimestamp;
    
    // Send snapshot to consumer
    const snapshotCount = this.sendSnapshot(consumerStream$, view);
    this.logger.debug(`Sending cached data to consumer - source: ${this.sourceName}, cachedRows: ${snapshotCount}, activeConsumers: ${this._consumerCount}`);
    
    // Subscribe to live updates after snapshot
    const subscription = this.subscribeToLiveUpdates(consumerStream$, snapshotTimestamp, view);
    
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
    
    // Dispose all cached views
    const disposePromises = Array.from(this.viewCache.values()).map(
      view => Promise.resolve(view.dispose())
    );
    await Promise.all(disposePromises);
    this.viewCache.clear();
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
   * Send cached snapshot data as INSERT events to a new consumer
   * Processes through view for unified streaming pipeline
   * Returns count for logging/metrics
   */
  private sendSnapshot(consumerStream$: ReplaySubject<RowUpdateEvent>, view: View): number {
    // Emit snapshot as insert events, processing through view
    let snapshotCount = 0;
    for (const row of this.cache.getAllRows()) {
      const event: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(Object.keys(row)),
        row: row
      };
      
      // Process through view for stateful filtering
      const processed = view.processEvent(event);
      if (processed) {
        consumerStream$.next(processed);
        snapshotCount++;
      }
    }
    
    return snapshotCount;
  }

  /**
   * Subscribe to live updates filtering by timestamp
   * Prevents duplicates by filtering events older than snapshot
   */
  private subscribeToLiveUpdates(consumerStream$: ReplaySubject<RowUpdateEvent>, snapshotTimestamp: bigint, view: View): Subscription {
    // Get the stream from the view
    const viewStream$ = view.stream;
    
    // Subscribe with timestamp filter
    return viewStream$.pipe(
      filter(([event, timestamp]) => timestamp > snapshotTimestamp),
      map(([event]) => event)
    ).subscribe(event => {
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


  /**
   * Get or create a view for the given filter
   */
  private getView(viewFilter: Filter): View {
    let view = this.viewCache.get(viewFilter.expression);
    
    if (!view) {
      // Create new view with source stream
      view = new View(viewFilter, this.sourceDef.primaryKeyField, this.internalUpdates$);
      
      // Cache the view
      this.viewCache.set(viewFilter.expression, view);
    }
    
    return view;
  }
}