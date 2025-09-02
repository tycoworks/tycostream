import { Client as WSClient } from 'graphql-ws';
import { StateTracker } from './tracker';

// Constructor options - just configuration and callbacks
export interface TestClientOptions {
  clientId: string;
  createWebSocketClient: () => WSClient;
  livenessTimeoutMs: number;
  onFinished: () => void; // Called when client converges to expected state
  onStalled: (clientId: string) => void; // Called when no data received for timeout period
  onRecovered: (clientId: string) => void; // Called when data arrives after a stall
}

// Subscription options
export interface SubscriptionOptions<TData = any> {
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>; // Required - what state we expect to reach
}

export class TestClient<TData = any> {
  private client: WSClient;
  
  // === Subscription State ===
  private stateTracker?: StateTracker<TData>;
  private subscriptionOptions?: SubscriptionOptions<TData>;
  
  // === Lifecycle State ===
  private finished = false;
  private stalled = false;
  private eventCount = 0;
  private lastEventTime = Date.now();
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;
  
  // === Liveness Tracking ===
  private livenessTimeout?: NodeJS.Timeout;

  constructor(private options: TestClientOptions) {
    this.client = options.createWebSocketClient();
    
    // Create the completion promise
    this.completionPromise = new Promise<void>((complete, fail) => {
      this.complete = complete;
      this.fail = fail;
    });
  }

  // === Subscription Management ===
  
  async subscribe(subscriptionOptions: SubscriptionOptions<TData>): Promise<void> {
    this.subscriptionOptions = subscriptionOptions;
    
    // Initialize StateTracker with subscription state management
    const stateTracker = new StateTracker<TData>(subscriptionOptions.expectedState);
    this.stateTracker = stateTracker;
    
    // Start liveness check
    this.resetLiveness();
    
    // TestClient owns the WebSocket subscription
    this.client.subscribe(
      { query: subscriptionOptions.query },
      {
        next: (data: any) => {
          this.handleDataReceived();
          this.processSubscriptionData(data, subscriptionOptions, stateTracker);
          this.checkIfFinished(stateTracker);
        },
        error: (error: any) => {
          const errorMessage = error?.message || error?.toString() || 'Unknown error';
          const contextError = new Error(`Client ${this.options.clientId}: Subscription error: ${errorMessage}`);
          this.handleError(contextError);
        },
        complete: () => {
          // Stream closed - this is an error condition for subscriptions
          const stats = this.stats;
          const error = new Error(
            `Client ${this.options.clientId}: Stream closed prematurely - events: ${stats.eventCount}, state size: ${stats.stateSize}`
          );
          this.handleError(error);
        },
      }
    );
  }
  
  private processSubscriptionData(data: any, subscriptionOptions: SubscriptionOptions<TData>, stateTracker: StateTracker<TData>): void {
    // Extract operation and data from standard GraphQL response structure
    const responseData = data.data[subscriptionOptions.dataPath];
    if (!responseData) return;
    
    const { operation, data: rowData, fields } = responseData;
    
    // Update state based on operation
    if (!rowData) {
      throw new Error(`Received ${operation} operation without data`);
    }
    
    const id = rowData[subscriptionOptions.idField];
    
    switch (operation) {
      case 'DELETE':
        stateTracker.delete(id);
        break;
        
      case 'INSERT':
        stateTracker.insert(id, rowData);
        break;
        
      case 'UPDATE':
        stateTracker.update(id, fields, rowData);
        break;
      
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
  
  // === Liveness & Stall Recovery ===
  
  private handleDataReceived(): void {
    // Track event for liveness
    this.eventCount++;
    this.lastEventTime = Date.now();
    
    // Handle stalled recovery
    if (this.stalled) {
      this.stalled = false;
      console.log(`Client ${this.options.clientId} recovered after stall - resuming with event ${this.stats.eventCount}`);
      this.options.onRecovered(this.options.clientId);
    }
    this.resetLiveness();
  }
  
  
  // Wait for the client to finish
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  // === Lifecycle Management ===
  
  private checkIfFinished(stateTracker: StateTracker<TData>) {
    if (!this.finished && stateTracker.isComplete()) {
      this.finished = true;
      const stats = stateTracker.getStats();
      console.log(`Client ${this.options.clientId} finished successfully - events: ${this.eventCount}, state size: ${stats.totalReceived}`);
      
      this.clearLivenessTimeout();
      
      // Notify manager
      this.options.onFinished();
      
      // Resolve the completion promise
      this.complete();
    }
  }
  
  private handleError(error: Error) {
    this.clearLivenessTimeout();
    this.finished = true; // Prevent further processing
    this.fail(error);
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
    try {
      this.client.dispose();
    } catch (e) {
      // Ignore disposal errors
    }
  }

  // === Getters & Utilities ===

  get stats() {
    const trackerStats = this.stateTracker?.getStats() || { 
      totalReceived: 0
    };
    return {
      eventCount: this.eventCount,
      stateSize: trackerStats.totalReceived,
      lastEventTime: this.lastEventTime,
      isFinished: this.finished,
      isStalled: this.stalled
    };
  }
}