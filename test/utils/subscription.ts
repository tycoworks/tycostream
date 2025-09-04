import { ApolloClient, gql } from '@apollo/client';
import { EventStream, EventProcessor, EventHandler, EventHandlerConfig, HandlerCallbacks, Stats, State } from './events';

/**
 * GraphQL subscription event stream
 * Manages the WebSocket subscription and delivers events
 */
class SubscriptionStream implements EventStream<any> {
  private subscription?: any;
  
  constructor(
    private client: ApolloClient,
    private query: string,
    private clientId: string,
    private id: string  // Required ID for logging
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
            `${this.id} for client ${this.clientId}: GraphQL error: ${errorMessage}`
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
          `${this.id} for client ${this.clientId}: Subscription error: ${errorMessage}`
        );
        if (onError) {
          onError(error instanceof Error ? error : new Error(errorMessage));
        }
      },
      complete: () => {
        // Stream closed - this is an error condition for subscriptions
        console.error(
          `${this.id} for client ${this.clientId}: Stream closed prematurely`
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
 * Creates a GraphQL subscription handler
 * Sets up the appropriate stream and processor, then returns an EventHandler
 */
export function createSubscriptionHandler<TData = any>(
  config: SubscriptionConfig<TData>
): EventHandler<TData> {
  // Create the processor with expected state
  const processor = new SubscriptionProcessor<TData>(
    config.expectedState,
    config.dataPath,
    config.idField
  );
  
  // Create the stream
  const stream = new SubscriptionStream(
    config.graphqlClient,
    config.query,
    config.clientId,
    config.id
  );
  
  // Create the handler config
  const handlerConfig: EventHandlerConfig = {
    id: config.id,
    clientId: config.clientId,
    callbacks: config.callbacks,
    livenessTimeoutMs: config.livenessTimeoutMs
  };
  
  // Create and return the handler with stream and processor
  return new EventHandler<TData>(stream, processor, handlerConfig);
}