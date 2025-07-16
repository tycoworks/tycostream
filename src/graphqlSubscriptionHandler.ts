import { logger, truncateForLog } from '../shared/logger.js';
import { nanoid } from 'nanoid';
import type { RowUpdateEvent, StreamSubscriber } from '../shared/databaseStreamer.js';
import PQueue from 'p-queue';

/**
 * Handles streaming for a single GraphQL subscription
 * Manages lifecycle from connection to disconnection with proper cleanup
 */
export class GraphQLSubscriptionHandler implements StreamSubscriber {
  private log = logger.child({ component: 'graphqlSubscription' });
  private isActive = true;
  private updateQueue: PQueue;
  private pendingUpdates: RowUpdateEvent[] = [];
  private eventSignal: (() => void) | null = null;
  private eventPromise: Promise<void> | null = null;
  private clientId: string;

  constructor(
    private viewName: string,
    clientId?: string
  ) {
    this.clientId = clientId || `client-${nanoid(10)}`;
    this.log = this.log.child({ clientId: this.clientId, viewName });
    
    // Use p-queue for proper async queue management with ordering guarantees
    // Follows IMPLEMENTATION.md guideline: "Prefer well-established libraries over custom implementations"
    // p-queue provides robust error handling, backpressure, and async task management
    this.updateQueue = new PQueue({ 
      concurrency: 1, // Process events one at a time to maintain order
      autoStart: true 
    });
    
    this.log.debug('GraphQL subscription handler created with event queue', {
      concurrency: 1,
      autoStart: true
    });
  }

  /**
   * Create async iterator for GraphQL subscription
   * Note: The caller is responsible for subscribing this handler to a stream
   */
  async* createAsyncIterator(): AsyncIterator<Record<string, any>> {
    if (!this.isActive) {
      throw new Error('GraphQL subscription handler is not active');
    }

    this.log.debug('Starting GraphQL subscription stream', { viewName: this.viewName });

    try {
      // Process all events in a purely event-driven manner
      while (this.isActive) {
        // Wait for events to arrive using promise-based signaling
        if (this.pendingUpdates.length === 0) {
          await this.waitForNextEvent();
        }

        // Process all pending events in order
        while (this.pendingUpdates.length > 0 && this.isActive) {
          const update = this.pendingUpdates.shift()!;
          
          this.log.debug('Processing event', {
            type: update.type,
            pendingCount: this.pendingUpdates.length,
            eventQueueSize: this.updateQueue.size
          });

          const payload = { [this.viewName]: update.row };
          const payloadSample = truncateForLog(payload);
          this.log.debug(`Yielding data to client: ${payloadSample}`);
          yield payload;
        }
      }
    } finally {
      this.close();
    }
  }

  /**
   * Handle incoming stream updates (implements StreamSubscriber interface)
   */
  onUpdate(event: RowUpdateEvent): void {
    if (!this.isActive) return;

    this.log.debug('Received row update', {
      type: event.type,
      pendingCount: this.pendingUpdates.length,
      eventQueueSize: this.updateQueue.size
    });

    this.pendingUpdates.push(event);
    
    // Signal that new events are available
    if (this.eventSignal) {
      const signal = this.eventSignal;
      this.eventSignal = null;
      this.eventPromise = null;
      signal();
    }
  }

  /**
   * Wait for the next event using promise-based signaling
   */
  private async waitForNextEvent(): Promise<void> {
    if (!this.isActive) return;
    
    this.eventPromise = new Promise<void>(resolve => {
      this.eventSignal = resolve;
    });
    
    await this.eventPromise;
  }

  /**
   * Close the subscription handler and cleanup resources
   */
  close(): void {
    if (!this.isActive) return;

    this.log.debug('Closing GraphQL subscription stream');
    this.isActive = false;

    // Clear any remaining queued updates
    this.pendingUpdates.length = 0;
    this.updateQueue.clear();

    this.log.debug('GraphQL subscription stream closed', {
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