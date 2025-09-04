import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks, Stats } from './handler';
import { StateTracker, State } from './tracker';

export interface SubscriptionConfig<TData = any> {
  id: string; // The subscription ID
  clientId: string;
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>;
  graphqlClient: ApolloClient;
  callbacks: HandlerCallbacks;
  livenessTimeoutMs: number;
}

/**
 * Handles GraphQL subscriptions over WebSocket
 * Parses GraphQL subscription events and calls appropriate callbacks
 */
export class SubscriptionHandler<TData = any> implements EventStreamHandler {
  private subscription?: any; // The Apollo subscription
  private currentState = new Map<string | number, TData>();
  private expectedState: Map<string | number, TData>;
  private startPromise?: Promise<void>;
  private stateTracker: StateTracker;
  
  constructor(private config: SubscriptionConfig<TData>) {
    this.expectedState = config.expectedState;
    
    // Initialize state tracker with callbacks that include our ID
    this.stateTracker = new StateTracker({
      livenessTimeoutMs: config.livenessTimeoutMs,
      onStalled: () => {
        console.log(`Subscription ${config.id} for client ${config.clientId} stalled`);
        config.callbacks.onStalled(config.id);
      },
      onRecovered: () => {
        console.log(`Subscription ${config.id} for client ${config.clientId} recovered`);
        config.callbacks.onRecovered(config.id);
      },
      onCompleted: () => {
        console.log(`Subscription ${config.id} for client ${config.clientId} completed`);
        this.cleanupSubscription();
        config.callbacks.onCompleted(config.id);
      },
      onFailed: () => {
        // The error is already logged when we detect it
        this.cleanupSubscription();
        config.callbacks.onFailed(config.id, new Error(`Subscription ${config.id} failed`));
      }
    });
  }
  
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    return this.startPromise;
  }
  
  private async doStart(): Promise<void> {
    this.subscription = this.config.graphqlClient.subscribe({
      query: gql`${this.config.query}`
    }).subscribe({
      next: (result) => {
        if (result.error) {
          const errorMessage = result.error?.message || 'Unknown GraphQL error';
          console.error(
            `Client ${this.config.clientId}: GraphQL error: ${errorMessage}`
          );
          this.stateTracker.markFailed();
          return;
        }
        
        // Process the subscription data
        this.processEvent(result.data);
      },
      error: (error) => {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error(
          `Client ${this.config.clientId}: Subscription error: ${errorMessage}`
        );
        this.stateTracker.markFailed();
      },
      complete: () => {
        // Stream closed - this is an error condition for subscriptions
        console.error(
          `Client ${this.config.clientId}: Stream closed prematurely`
        );
        this.stateTracker.markFailed();
      }
    });
  }
  
  private processEvent(data: any): void {
    // Record activity for liveness tracking
    this.stateTracker.recordActivity();
    
    // Extract operation and data from standard GraphQL response structure
    const responseData = data[this.config.dataPath];
    if (!responseData) {
      // No data at expected path, check if we're done
      this.checkCompletion();
      return;
    }
    
    const { operation, data: rowData, fields } = responseData;
    
    if (!rowData) {
      console.error(`Received ${operation} operation without data`);
      this.stateTracker.markFailed();
      return;
    }
    
    // Apollo 4 always adds __typename - filter it out for clean state comparison
    const cleanData = { ...rowData };
    delete cleanData.__typename;
    
    const id = cleanData[this.config.idField];
    
    // Update current state directly
    switch (operation) {
      case 'DELETE':
        this.currentState.delete(id);
        break;
        
      case 'INSERT':
        this.currentState.set(id, cleanData);
        break;
        
      case 'UPDATE':
        const existing = this.currentState.get(id);
        if (existing) {
          const updated = { ...existing };
          for (const field of fields) {
            updated[field as keyof TData] = cleanData[field];
          }
          this.currentState.set(id, updated);
        }
        break;
      
      default:
        console.error(`Unknown operation: ${operation}`);
        this.stateTracker.markFailed();
        return;
    }
    
    // Check if we're finished after state update
    this.checkCompletion();
  }
  
  private checkCompletion(): void {
    if (this.isComplete()) {
      this.stateTracker.markCompleted();
    }
  }
  
  private isComplete(): boolean {
    if (this.currentState.size === this.expectedState.size) {
      for (const [id, expectedData] of this.expectedState) {
        const currentData = this.currentState.get(id);
        if (!currentData || JSON.stringify(currentData) !== JSON.stringify(expectedData)) {
          return false;
        }
      }
      return true;
    }
    return false;
  }
  
  getState(): State {
    return this.stateTracker.getState();
  }
  
  getStats(): Stats {
    return {
      totalExpected: this.expectedState.size,
      totalReceived: this.currentState.size
    };
  }
  
  private cleanupSubscription(): void {
    if (this.subscription) {
      console.log(`Unsubscribing from GraphQL subscription for ${this.config.id}`);
      this.subscription.unsubscribe();
      this.subscription = undefined;
    }
  }
  
  async dispose(): Promise<void> {
    this.stateTracker.dispose();
    this.cleanupSubscription();
  }
}