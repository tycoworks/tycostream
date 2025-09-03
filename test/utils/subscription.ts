import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks } from './handler';
import { StateTracker } from './tracker';

export interface GraphQLSubscriptionConfig<TData = any> {
  clientId: string;
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>;
  callbacks: HandlerCallbacks;
}

/**
 * Handles GraphQL subscriptions over WebSocket
 * Parses GraphQL subscription events and calls appropriate callbacks
 */
export class SubscriptionHandler<TData = any> implements EventStreamHandler {
  private subscription?: any; // The Apollo subscription
  private tracker: StateTracker<TData>;
  
  constructor(private config: GraphQLSubscriptionConfig<TData>) {
    this.tracker = new StateTracker<TData>(config.expectedState);
  }
  
  async start(graphqlClient: ApolloClient): Promise<void> {
    this.subscription = graphqlClient.subscribe({
      query: gql`${this.config.query}`
    }).subscribe({
      next: (result) => {
        if (result.error) {
          const errorMessage = result.error?.message || 'Unknown GraphQL error';
          const contextError = new Error(
            `Client ${this.config.clientId}: GraphQL error: ${errorMessage}`
          );
          this.config.callbacks.onError(contextError);
          return;
        }
        
        // Process the subscription data
        this.processEvent(result.data);
      },
      error: (error) => {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        const contextError = new Error(
          `Client ${this.config.clientId}: Subscription error: ${errorMessage}`
        );
        this.config.callbacks.onError(contextError);
      },
      complete: () => {
        // Stream closed - this is an error condition for subscriptions
        const error = new Error(
          `Client ${this.config.clientId}: Stream closed prematurely`
        );
        this.config.callbacks.onError(error);
      }
    });
  }
  
  private processEvent(data: any): void {
    // First: notify that data was received (for liveness tracking)
    this.config.callbacks.onDataReceived();
    
    // Extract operation and data from standard GraphQL response structure
    const responseData = data[this.config.dataPath];
    if (!responseData) {
      // No data at expected path, check if we're done
      this.config.callbacks.onCheckFinished();
      return;
    }
    
    const { operation, data: rowData, fields } = responseData;
    
    if (!rowData) {
      const error = new Error(`Received ${operation} operation without data`);
      this.config.callbacks.onError(error);
      return;
    }
    
    // Apollo 4 always adds __typename - filter it out for clean state comparison
    const cleanData = { ...rowData };
    delete cleanData.__typename;
    
    const id = cleanData[this.config.idField];
    
    // Update the state tracker directly
    switch (operation) {
      case 'DELETE':
        this.tracker.delete(id);
        break;
        
      case 'INSERT':
        this.tracker.insert(id, cleanData);
        break;
        
      case 'UPDATE':
        this.tracker.update(id, fields, cleanData);
        break;
      
      default:
        const error = new Error(`Unknown operation: ${operation}`);
        this.config.callbacks.onError(error);
        return;
    }
    
    // Last: check if we're finished (after state has been updated)
    this.config.callbacks.onCheckFinished();
  }
  
  isComplete(): boolean {
    return this.tracker.isComplete();
  }
  
  getStats() {
    return this.tracker.getStats();
  }
  
  dispose(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = undefined;
    }
  }
}