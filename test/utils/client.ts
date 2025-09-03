import { Client as WSClient } from 'graphql-ws';
import { StateTracker } from './tracker';

// Constructor options - just configuration and callbacks
export interface TestClientOptions {
  clientId: string;
  createWebSocketClient: () => WSClient;
  createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
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

// Trigger/webhook options
export interface TriggerOptions<TData = any> {
  query: string;                         // GraphQL mutation to create trigger
  expectedEvents: TData[];              // Expected webhook payloads in order
  idField: string;                      // Primary key field for state tracking
}

export class TestClient<TData = any> {
  private client: WSClient;
  
  // === Subscription State ===
  private subscriptionTracker?: StateTracker<TData>;
  private subscriptionOptions?: SubscriptionOptions<TData>;
  
  // === Trigger State ===
  private triggerTracker?: StateTracker<TData>;
  private triggerOptions?: TriggerOptions<TData>;
  
  // === Lifecycle State ===
  private finished = false;
  private stalled = false;
  private eventCount = 0;
  private lastEventTime = Date.now();
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;
  private readyPromise!: Promise<void>;
  private readyResolve!: () => void;
  private isReady = false;
  
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

  // === Public Methods ===
  
  configureSubscription(subscriptionOptions: SubscriptionOptions<TData>): void {
    if (this.subscriptionOptions) {
      throw new Error(`Client ${this.options.clientId}: Subscription already configured`);
    }
    this.subscriptionOptions = subscriptionOptions;
  }
  
  configureTrigger(triggerOptions: TriggerOptions<TData>): void {
    if (this.triggerOptions) {
      throw new Error(`Client ${this.options.clientId}: Trigger already configured`);
    }
    this.triggerOptions = triggerOptions;
  }
  
  async start(): Promise<void> {
    // Must have at least one configuration
    if (!this.subscriptionOptions && !this.triggerOptions) {
      throw new Error(`Client ${this.options.clientId}: No subscription or trigger configured`);
    }
    
    // Create ready promise
    this.readyPromise = new Promise<void>(resolve => {
      this.readyResolve = resolve;
    });
    
    // Start liveness monitoring
    this.resetLiveness();
    
    // Start subscription if configured
    if (this.subscriptionOptions) {
      // Initialize subscription tracker
      this.subscriptionTracker = new StateTracker<TData>(this.subscriptionOptions.expectedState);
      
      // Mark as ready once subscription is set up (not waiting for first data)
      // The subscribe call is synchronous, so we can resolve immediately after
      this.client.subscribe(
        { query: this.subscriptionOptions.query },
        {
          next: (data: any) => {
            this.processData(() => {
              this.processSubscriptionData(data, this.subscriptionOptions!, this.subscriptionTracker!);
            });
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
    
    // Set up webhook and execute trigger mutation if configured
    if (this.triggerOptions) {
      // Convert array to Map for StateTracker, preserving order via insertion sequence
      const expectedStateMap = new Map<string | number, TData>();
      const idField = this.triggerOptions.idField;
      this.triggerOptions.expectedEvents.forEach((event, index) => {
        const id = event[idField] || index;
        expectedStateMap.set(id, event);
      });
      this.triggerTracker = new StateTracker<TData>(expectedStateMap);
      
      // Generate unique trigger name based on client ID
      const triggerName = `trigger_${this.options.clientId}_${Date.now()}`;
      
      // Register webhook endpoint
      const endpoint = `/webhook/${this.options.clientId}/${triggerName}`;
      const webhookUrl = this.options.createWebhook(endpoint, async (payload) => {
        console.log(`Client ${this.options.clientId} received webhook for trigger ${triggerName}`);
        
        this.processData(() => {
          // Process webhook data - extract ID using configured idField
          const id = payload.data?.[this.triggerOptions!.idField] || payload[this.triggerOptions!.idField] || payload.trigger_name || Date.now();
          this.triggerTracker!.insert(id, payload);
        });
      });
      
      console.log(`Registered webhook endpoint: ${webhookUrl}`);
      
      // TODO: Execute the GraphQL mutation to create the trigger
      // The mutation query should include the webhookUrl in its variables
      // e.g., replacing $webhook placeholder with the actual webhookUrl
    }
    
    // All setup is complete (subscription and/or webhook), mark as ready
    this.isReady = true;
    this.readyResolve();
    
    // Return the ready promise (resolves when client is ready)
    return this.readyPromise;
  }
  
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  dispose() {
    this.clearLivenessTimeout();
    try {
      this.client.dispose();
    } catch (e) {
      // Ignore disposal errors
    }
  }

  get stats() {
    // Combine stats from both trackers
    const subStats = this.subscriptionTracker?.getStats() || { totalReceived: 0 };
    const triggerStats = this.triggerTracker?.getStats() || { totalReceived: 0 };
    
    return {
      eventCount: this.eventCount,
      stateSize: subStats.totalReceived + triggerStats.totalReceived,
      lastEventTime: this.lastEventTime,
      isFinished: this.finished,
      isStalled: this.stalled
    };
  }

  // === Private Methods ===

  private processData(dataHandler: () => void): void {
    this.handleDataReceived();
    dataHandler();
    this.checkIfFinished();
  }

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

  private checkIfFinished() {
    if (this.finished) return;
    
    // Check if ALL active trackers are complete
    const subscriptionComplete = !this.subscriptionTracker || this.subscriptionTracker.isComplete();
    const triggerComplete = !this.triggerTracker || this.triggerTracker.isComplete();
    
    if (subscriptionComplete && triggerComplete) {
      this.finished = true;
      console.log(`Client ${this.options.clientId} finished successfully - events: ${this.eventCount}, state size: ${this.stats.stateSize}`);
      
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
}