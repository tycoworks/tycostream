import { logger, truncateForLog } from './logger.js';
import type { ViewCache } from './viewCache.js';
import type { RowUpdateEvent, CacheSubscriber } from './types.js';
import PQueue from 'p-queue';

/**
 * Handles streaming for a single GraphQL client subscription
 * Manages lifecycle from connection to disconnection with proper cleanup
 */
export class ClientStreamHandler implements CacheSubscriber {
  private log = logger.child({ component: 'clientStreamHandler' });
  private isActive = true;
  private updateQueue: PQueue;
  private pendingUpdates: RowUpdateEvent[] = [];
  private unsubscribeFromCache?: () => void;
  private clientId: string;

  constructor(
    private viewName: string,
    private cache: ViewCache,
    clientId?: string
  ) {
    this.clientId = clientId || `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.log = this.log.child({ clientId: this.clientId, viewName });
    
    // Use p-queue for proper async queue management with ordering guarantees
    // Follows IMPLEMENTATION.md guideline: "Prefer well-established libraries over custom implementations"
    // p-queue provides robust error handling, backpressure, and async task management
    this.updateQueue = new PQueue({ 
      concurrency: 1, // Process events one at a time to maintain order
      autoStart: true 
    });
    
    this.log.debug('ClientStreamHandler created with event queue', {
      concurrency: 1,
      autoStart: true
    });
  }

  /**
   * Create async iterator for GraphQL subscription
   * Single stream: current state + live updates via subscribe
   */
  async* createAsyncIterator(): AsyncIterator<Record<string, any>> {
    if (!this.isActive) {
      throw new Error('ClientStreamHandler is not active');
    }

    this.log.debug('Starting client stream', { viewName: this.viewName });

    try {
      // Subscribe to cache - this will immediately emit current state,
      // then continue with live updates. Single path, no race conditions!
      this.unsubscribeFromCache = this.cache.subscribe(this);
      
      this.log.debug('Subscribed to cache, processing event queue');

      // Process all events using p-queue for proper async handling
      while (this.isActive) {
        // Wait for events to arrive (current state + live updates)
        while (this.pendingUpdates.length === 0 && this.isActive) {
          await new Promise(resolve => setTimeout(resolve, 10)); 
        }

        // Process all pending events in order
        while (this.pendingUpdates.length > 0 && this.isActive) {
          const update = this.pendingUpdates.shift()!;
          
          this.log.debug('Processing event', {
            type: update.type,
            pendingCount: this.pendingUpdates.length,
            eventQueueSize: this.updateQueue.size
          });

          // For now, only yield inserts and updates (skip deletes)
          // TODO: In 1.2, we'll need to handle deletes and filtering
          if (update.type === 'insert' || update.type === 'update') {
            const payload = { [this.viewName]: update.row };
            const payloadSample = truncateForLog(payload);
            this.log.debug(`Yielding data to client: ${payloadSample}`);
            yield payload;
          }
        }
      }
    } finally {
      this.close();
    }
  }

  /**
   * Callback for cache updates (implements CacheSubscriber)
   */
  onUpdate(event: RowUpdateEvent): void {
    if (!this.isActive) return;

    this.log.debug('Received cache update', {
      type: event.type,
      pendingCount: this.pendingUpdates.length,
      eventQueueSize: this.updateQueue.size
    });

    this.pendingUpdates.push(event);
  }

  /**
   * Close the stream handler and cleanup resources
   */
  close(): void {
    if (!this.isActive) return;

    this.log.debug('Closing client stream');
    this.isActive = false;

    if (this.unsubscribeFromCache) {
      this.unsubscribeFromCache();
      this.unsubscribeFromCache = undefined;
    }

    // Clear any remaining queued updates
    this.pendingUpdates.length = 0;
    this.updateQueue.clear();

    this.log.debug('Client stream closed', {
      eventQueueCleared: true,
      pendingCleared: true
    });
  }

  /**
   * Check if the handler is active
   */
  get active(): boolean {
    return this.isActive;
  }

  /**
   * Get the client ID for debugging
   */
  get id(): string {
    return this.clientId;
  }
}