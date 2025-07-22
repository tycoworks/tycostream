import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject, ReplaySubject, filter } from 'rxjs';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseSubscriber } from './database-subscriber';
import type { ProtocolHandler } from './types';
import type { SourceDefinition } from '../config/source-definition.types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import type { Cache } from './cache.types';
import { SimpleCache } from './cache';

/**
 * Database streaming service for a single source
 * Handles Observable-based streaming with late joiner support
 * Uses DatabaseProtocolHandler for database connection management
 */
@Injectable()
export class DatabaseStreamingService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamingService.name);
  private readonly cache: Cache;
  private readonly internalUpdates$ = new Subject<RowUpdateEvent>();
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
  getUpdates(): Observable<RowUpdateEvent> {
    if (this.isShuttingDown) {
      throw new Error('Database subscriber is shutting down, cannot accept new subscriptions');
    }

    // Start streaming if not already started
    if (!this.databaseSubscriber.streaming && !this.isShuttingDown) {
      this.startStreaming().catch(error => {
        this.logger.error(`Failed to start streaming for ${this.sourceName}`, error);
        // Error will be propagated through Observable error handling
      });
    }

    // Increment consumer count
    this._consumerCount++;

    // Create a replayable stream for this consumer
    const consumerStream$ = new ReplaySubject<RowUpdateEvent>();
    
    // Take snapshot before subscribing to avoid race condition
    const snapshotTimestamp = this.latestTimestamp;
    const snapshot = this.cache.getAllRows();
    
    // Emit snapshot as insert events
    let snapshotCount = 0;
    for (const row of snapshot) {
      consumerStream$.next({
        type: RowUpdateType.Insert,
        row: { ...row },
        timestamp: snapshotTimestamp
      });
      snapshotCount++;
    }
    
    this.logger.debug('Sending cached data to consumer', {
      sourceName: this.sourceName,
      cachedRowCount: snapshotCount,
      activeConsumers: this._consumerCount
    });
    
    // Subscribe to future updates with timestamp filter
    const subscription = this.internalUpdates$.pipe(
      filter((event: RowUpdateEvent) => {
        // Only emit events newer than snapshot timestamp
        return event.timestamp > snapshotTimestamp;
      })
    ).subscribe(event => {
      // Forward the complete event to consumer
      consumerStream$.next(event);
    });
    
    this.logger.debug('Consumer connected', {
      sourceName: this.sourceName,
      cacheSize: this.cache.size,
      activeConsumers: this._consumerCount
    });

    // Return observable that handles cleanup on unsubscribe
    return new Observable<RowUpdateEvent>(subscriber => {
      const proxySubscription = consumerStream$.subscribe(subscriber);
      
      // Return teardown logic
      return () => {
        // Decrement consumer count
        this._consumerCount--;
        
        this.logger.debug('Consumer disconnected', {
          sourceName: this.sourceName,
          remainingConsumers: this._consumerCount
        });
        
        // Clean up subscriptions
        subscription.unsubscribe();
        proxySubscription.unsubscribe();
        consumerStream$.complete();
      };
    });
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

  // Internal methods for testing only
  /** @internal */
  _getAllRows(): Record<string, any>[] {
    return this.cache.getAllRows();
  }

  /** @internal */
  _getRow(primaryKey: string | number): Record<string, any> | undefined {
    return this.cache.get(primaryKey);
  }

  /**
   * Cleanup on module destroy
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
   * Internal method to start streaming
   */
  private async startStreaming(): Promise<void> {
    try {
      // Start database streaming with callback for updates and errors
      await this.databaseSubscriber.startStreaming(
        (row: Record<string, any>, timestamp: bigint, isDelete: boolean) => {
          this.processUpdate(row, timestamp, isDelete);
        },
        (error: Error) => {
          // Propagate runtime database errors to all subscribers
          this.internalUpdates$.error(error);
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
   */
  private processUpdate(row: Record<string, any>, timestamp: bigint, isDelete: boolean): void {
    // Update timestamp tracking
    this.latestTimestamp = timestamp;

    // Determine correct event type based on cache state and delete flag
    let eventType: RowUpdateType;
    if (isDelete) {
      eventType = RowUpdateType.Delete;
    } else {
      // Check if row exists in cache to determine insert vs update
      const exists = this.cache.get(row[this.sourceDef.primaryKeyField]) !== undefined;
      eventType = exists ? RowUpdateType.Update : RowUpdateType.Insert;
    }

    // Update cache based on event type
    if (eventType === RowUpdateType.Delete) {
      this.cache.delete(row);
    } else {
      this.cache.set(row);
    }

    // Emit to internal subject
    this.internalUpdates$.next({
      type: eventType,
      row,
      timestamp
    });
  }
}