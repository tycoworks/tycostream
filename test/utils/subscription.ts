import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, EventStream, EventProcessor, HandlerCallbacks, Stats } from './events';
import { StateTracker, State } from './tracker';

/**
 * GraphQL subscription event stream
 * Manages the WebSocket subscription and delivers events
 */
class GraphQLSubscriptionStream implements EventStream<any> {
  private subscription?: any;
  
  constructor(
    private client: ApolloClient,
    private query: string,
    private clientId: string
  ) {}
  
  async subscribe(
    onData: (data: any) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    this.subscription = this.client.subscribe({
      query: gql`${this.query}`
    }).subscribe({
      next: (result) => {
        if (result.error) {
          const errorMessage = result.error?.message || 'Unknown GraphQL error';
          console.error(
            `Client ${this.clientId}: GraphQL error: ${errorMessage}`
          );
          if (onError) {
            onError(new Error(errorMessage));
          }
          return;
        }
        
        // Deliver the data via callback
        onData(result.data);
      },
      error: (error) => {
        const errorMessage = error?.message || error?.toString() || 'Unknown error';
        console.error(
          `Client ${this.clientId}: Subscription error: ${errorMessage}`
        );
        if (onError) {
          onError(error instanceof Error ? error : new Error(errorMessage));
        }
      },
      complete: () => {
        // Stream closed - this is an error condition for subscriptions
        console.error(
          `Client ${this.clientId}: Stream closed prematurely`
        );
        if (onError) {
          onError(new Error('Stream closed prematurely'));
        }
      }
    });
  }
  
  async unsubscribe(): Promise<void> {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = undefined;
    }
  }
}

/**
 * Processes subscription events by maintaining a state map
 * Handles INSERT/UPDATE/DELETE operations
 */
class SubscriptionProcessor<TData = any> implements EventProcessor<TData> {
  private currentState = new Map<string | number, TData>();
  
  constructor(
    private expectedState: Map<string | number, TData>,
    private dataPath: string,
    private idField: string
  ) {}
  
  processEvent(data: any): void {
    // Extract operation and data from standard GraphQL response structure
    const responseData = data[this.dataPath];
    if (!responseData) {
      return;
    }
    
    const { operation, data: rowData, fields } = responseData;
    
    if (!rowData) {
      console.error(`Received ${operation} operation without data`);
      throw new Error(`Invalid operation data`);
    }
    
    // Apollo 4 always adds __typename - filter it out for clean state comparison
    const cleanData = { ...rowData };
    delete cleanData.__typename;
    
    const id = cleanData[this.idField];
    
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
        throw new Error(`Unknown operation: ${operation}`);
    }
  }
  
  isComplete(): boolean {
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
  
  getStats(): Stats {
    return {
      totalExpected: this.expectedState.size,
      totalReceived: this.currentState.size
    };
  }
}

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
  private stream?: GraphQLSubscriptionStream;
  private processor: SubscriptionProcessor<TData>;
  private startPromise?: Promise<void>;
  private stateTracker: StateTracker;
  
  constructor(private config: SubscriptionConfig<TData>) {
    // Create the processor with expected state
    this.processor = new SubscriptionProcessor<TData>(
      config.expectedState,
      config.dataPath,
      config.idField
    );
    
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
      onCompleted: async () => {
        console.log(`Subscription ${config.id} for client ${config.clientId} completed`);
        await this.cleanupSubscription();
        config.callbacks.onCompleted(config.id);
      },
      onFailed: async () => {
        // The error is already logged when we detect it
        await this.cleanupSubscription();
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
    // Create the stream
    this.stream = new GraphQLSubscriptionStream(
      this.config.graphqlClient,
      this.config.query,
      this.config.clientId
    );
    
    // Subscribe to the stream
    await this.stream.subscribe(
      (data) => {
        // Process the subscription data
        this.processEvent(data);
      },
      (error) => {
        // Stream error - mark as failed
        this.stateTracker.markFailed();
      }
    );
  }
  
  private processEvent(data: any): void {
    // Record activity for liveness tracking
    this.stateTracker.recordActivity();
    
    try {
      // Delegate processing to the processor
      this.processor.processEvent(data);
      
      // Check if we're finished after state update
      if (this.processor.isComplete()) {
        this.stateTracker.markCompleted();
      }
    } catch (error) {
      // If processing fails, mark as failed
      this.stateTracker.markFailed();
    }
  }
  
  getState(): State {
    return this.stateTracker.getState();
  }
  
  getStats(): Stats {
    return this.processor.getStats();
  }
  
  private async cleanupSubscription(): Promise<void> {
    if (this.stream) {
      console.log(`Unsubscribing from GraphQL subscription for ${this.config.id}`);
      await this.stream.unsubscribe();
      this.stream = undefined;
    }
  }
  
  async dispose(): Promise<void> {
    this.stateTracker.dispose();
    await this.cleanupSubscription();
  }
}