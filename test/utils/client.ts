import { createClient, Client as WSClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { StateTracker } from './tracker';

// Constructor options - just configuration and callbacks
export interface TestClientOptions {
  clientId: string;
  appPort: number;
  livenessTimeoutMs: number;
  onFinished: () => void;
  onStalled: (clientId: string) => void;
  onRecovered: (clientId: string) => void;
}

// Subscription options
export interface SubscriptionOptions<TData = any> {
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>; // Required - what state we expect to reach
  onOperation?: (operation: string, data: TData) => void; // Callback for each operation
}

export class TestClient<TData = any> {
  private client: WSClient;
  private stateTracker?: StateTracker<TData>;
  private subscriptionOptions?: SubscriptionOptions<TData>;
  private finished = false;
  private stalled = false;
  private livenessTimeout?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private completionPromise: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;

  constructor(private options: TestClientOptions) {
    this.client = this.createWebSocketClient(options.appPort);
    
    // Create the completion promise
    this.completionPromise = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  // Subscribe to GraphQL subscription
  async subscribe(subscriptionOptions: SubscriptionOptions<TData>): Promise<void> {
    this.subscriptionOptions = subscriptionOptions;
    
    // Create StateTracker for subscription state management
    this.stateTracker = new StateTracker<TData>({
      expectedState: subscriptionOptions.expectedState,
      extractId: (event: any) => event.rowData[subscriptionOptions.idField],
      handleEvent: this.createSubscriptionHandler()
    });
    
    // Start liveness check
    this.resetLiveness();

    this.unsubscribe = this.client.subscribe(
      { query: subscriptionOptions.query },
      {
        next: (data: any) => {
          this.handleUpdate(data, subscriptionOptions, this.stateTracker!);
        },
        error: (error: any) => {
          const errorMessage = error?.message || error?.toString() || 'Unknown error';
          console.error(`Client ${this.options.clientId} subscription error:`, errorMessage);
          this.handleError(new Error(`Client ${this.options.clientId} subscription error: ${errorMessage}`));
        },
        complete: () => {
          // Stream closed - this is an error condition
          const stats = this.stats;
          const error = this.finished 
            ? new Error(`Client ${this.options.clientId} stream closed unexpectedly after completion`)
            : new Error(`Client ${this.options.clientId} stream closed prematurely - events: ${stats.eventCount}, state size: ${stats.stateSize}`);
          this.handleError(error);
        },
      }
    );
    
    // Return immediately - subscription is set up
  }
  
  // Wait for the client to finish
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  private handleUpdate(data: any, subscriptionOptions: SubscriptionOptions<TData>, stateTracker: StateTracker<TData>) {
    // If we were stalled, report recovery
    if (this.stalled) {
      this.stalled = false;
      console.log(`Client ${this.options.clientId} recovered after stall - resuming with event ${this.stats.eventCount}`);
      this.options.onRecovered(this.options.clientId);
    }
    
    this.resetLiveness();

    // Extract operation and data from standard GraphQL response structure
    const responseData = data.data[subscriptionOptions.dataPath];
    if (!responseData) return;
    
    const { operation, data: rowData, fields } = responseData;
    
    // Notify callback
    if (subscriptionOptions.onOperation) {
      subscriptionOptions.onOperation(operation, rowData);
    }
    
    // Update state based on operation
    if (!rowData) {
      throw new Error(`Received ${operation} operation without data`);
    }
    
    // Let StateTracker handle the event - pass the full response for context
    stateTracker.handleEvent({ rowData, fields }, operation);

    // Check if we're finished on EVERY update
    if (!this.finished) {
      this.checkIfFinished();
    }
  }
  
  private checkIfFinished() {
    if (!this.hasSubscription) return;
    
    const isFinished = this.stateTracker!.isComplete();
      
    if (isFinished) {
      this.finished = true;
      const stats = this.stateTracker!.getStats();
      console.log(`Client ${this.options.clientId} finished successfully - events: ${stats.eventCount}, state size: ${stats.totalReceived}`);
      
      this.clearLivenessTimeout();
      
      // Notify manager
      this.options.onFinished();
      
      // Resolve the completion promise
      this.resolveCompletion();
    }
  }
  
  
  private handleError(error: Error) {
    this.clearLivenessTimeout();
    this.finished = true; // Prevent further processing
    this.rejectCompletion(error);
  }

  private resetLiveness() {
    this.clearLivenessTimeout();
    if (!this.finished) {
      const timeoutMs = this.options.livenessTimeoutMs;
      this.livenessTimeout = setTimeout(() => {
        // Don't error out - just mark as stalled and notify manager
        this.stalled = true;
        const stats = this.stats;
        console.warn(`Client ${this.options.clientId} stalled - no messages for ${timeoutMs}ms. Events: ${stats.eventCount}, State size: ${stats.stateSize}`);
        this.options.onStalled(this.options.clientId);
        
        // Keep the liveness check going in case we recover
        this.resetLiveness();
      }, timeoutMs);
    }
  }

  private clearLivenessTimeout() {
    if (this.livenessTimeout) {
      clearTimeout(this.livenessTimeout);
      this.livenessTimeout = undefined;
    }
  }

  dispose() {
    this.clearLivenessTimeout();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    try {
      this.client.dispose();
    } catch (e) {
      // Ignore disposal errors
    }
  }

  get hasSubscription(): boolean {
    return this.stateTracker !== undefined;
  }

  get stats() {
    const trackerStats = this.stateTracker?.getStats() || { 
      eventCount: 0, 
      totalReceived: 0, 
      lastEventTime: Date.now() 
    };
    return {
      eventCount: trackerStats.eventCount,
      stateSize: trackerStats.totalReceived,
      lastEventTime: trackerStats.lastEventTime,
      isFinished: this.finished,
      isStalled: this.stalled
    };
  }
  
  private createWebSocketClient(port: number): WSClient {
    return createClient({
      url: `ws://localhost:${port}/graphql`,
      webSocketImpl: WebSocket as any,
    });
  }

  private createSubscriptionHandler() {
    return (currentState: Map<string | number, TData>, id: string | number, event: any, operation: string) => {
      const newState = new Map(currentState);
      
      switch (operation) {
        case 'DELETE':
          newState.delete(id);
          break;
          
        case 'INSERT':
          newState.set(id, event.rowData);
          break;
          
        case 'UPDATE': {
          // UPDATE operations only contain changed fields + primary key
          // We need to merge with existing state
          const existing = newState.get(id);
          if (!existing) {
            throw new Error(`UPDATE for non-existent row with id=${id}`);
          }
          
          // Only update fields that are actually present in the update
          const updated = { ...existing };
          for (const field of event.fields) {
            updated[field] = event.rowData[field];
          }
          newState.set(id, updated);
          break;
        }
      }
      
      return newState;
    };
  }

}