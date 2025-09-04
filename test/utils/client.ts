import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { createSubscriptionHandler } from './subscription';
import { createTriggerHandler } from './trigger';
import { EventHandler, HandlerCallbacks, Stats, State } from './events';
import { GraphQLEndpoint } from './environment';
import { WebhookEndpoint } from './webhook';

// Constructor options - just configuration and callbacks
export interface TestClientOptions {
  clientId: string;
  graphqlEndpoint: GraphQLEndpoint;
  webhookEndpoint: WebhookEndpoint;
  livenessTimeoutMs: number;
  onCompleted: () => void; // Called when client completes successfully
  onFailed: (error: Error) => void; // Called when client fails
  onStalled: (clientId: string) => void; // Called when all handlers are stalled
  onRecovered: (clientId: string) => void; // Called when data resumes after a stall
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
  deleteQuery: string;                   // GraphQL mutation to delete trigger (required for cleanup)
  expectedEvents: TData[];              // Expected webhook payloads in order
  idField: string;                      // Primary key field for state tracking
}

export class TestClient<TData = any> {
  private graphqlClient: ApolloClient;
  
  // === Handlers ===
  private handlers = new Map<string, EventHandler>();
  
  // === Lifecycle State ===
  private state: State = State.Active;
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;

  constructor(private options: TestClientOptions) {
    // Create Apollo client with WebSocket support using graphql-ws
    const { host, port, path } = options.graphqlEndpoint;
    const wsUrl = `ws://${host}:${port}${path}`;
    
    const wsClient = createClient({
      url: wsUrl,
      webSocketImpl: WebSocket as any
    });
    
    this.graphqlClient = new ApolloClient({
      link: new GraphQLWsLink(wsClient),
      cache: new InMemoryCache()
    });
    
    // Create the completion promise
    this.completionPromise = new Promise<void>((complete, fail) => {
      this.complete = complete;
      this.fail = fail;
    });
  }

  // === Public Methods ===
  
  async subscribe(id: string, options: SubscriptionOptions<TData>): Promise<void> {
    if (this.handlers.has(id)) {
      throw new Error(`Client ${this.options.clientId}: Handler '${id}' already exists`);
    }
    
    // Create and start subscription handler
    const handler = createSubscriptionHandler<TData>({
      id,
      clientId: this.options.clientId,
      query: options.query,
      dataPath: options.dataPath,
      idField: options.idField,
      expectedState: options.expectedState,
      graphqlClient: this.graphqlClient,
      callbacks: this.createHandlerCallbacks(),
      livenessTimeoutMs: this.options.livenessTimeoutMs
    });
    
    await handler.start();
    this.handlers.set(id, handler);
  }
  
  async trigger(id: string, options: TriggerOptions<TData>): Promise<void> {
    if (this.handlers.has(id)) {
      throw new Error(`Client ${this.options.clientId}: Handler '${id}' already exists`);
    }
    
    // Create and start trigger handler
    const handler = createTriggerHandler<TData>({
      id,
      clientId: this.options.clientId,
      query: options.query,
      deleteQuery: options.deleteQuery,
      idField: options.idField,
      expectedEvents: options.expectedEvents,
      webhookEndpoint: this.options.webhookEndpoint,
      graphqlClient: this.graphqlClient,
      callbacks: this.createHandlerCallbacks(),
      livenessTimeoutMs: this.options.livenessTimeoutMs
    });
    
    await handler.start();
    this.handlers.set(id, handler);
  }
  
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  async dispose(): Promise<void> {
    // Dispose all handlers
    await Promise.all(
      Array.from(this.handlers.values()).map(handler => handler.dispose())
    );
    this.handlers.clear();
  }

  getState(): State {
    return this.state;
  }
  
  getStats(): Stats {
    let totalExpected = 0;
    let totalReceived = 0;
    
    for (const handler of this.handlers.values()) {
      const stats = handler.getStats();
      totalExpected += stats.totalExpected;
      totalReceived += stats.totalReceived;
    }
    
    return {
      totalExpected,
      totalReceived
    };
  }

  // === Private Methods ===

  private createHandlerCallbacks(): HandlerCallbacks {
    return {
      onStalled: (handlerId) => this.handleStalled(handlerId),
      onRecovered: (handlerId) => this.handleRecovered(handlerId),
      onCompleted: (handlerId) => this.handleCompleted(handlerId),
      onFailed: (handlerId, error) => this.handleFailed(handlerId, error)
    };
  }

  private handleStalled(handlerId: string): void {
    // Only update state if we're not in a terminal state
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    // Check if ALL handlers are now stalled
    const allStalled = Array.from(this.handlers.values()).every(
      handler => handler.getState() === State.Stalled
    );
    
    // Update state and notify if ALL handlers are stalled
    if (allStalled && this.state !== State.Stalled) {
      this.state = State.Stalled;
      console.log(`Client ${this.options.clientId} stalled - all handlers stopped receiving data`);
      this.options.onStalled(this.options.clientId);
    }
  }
  
  private handleRecovered(handlerId: string): void {
    // Only process recovery if we were stalled
    if (this.state === State.Stalled) {
      this.state = State.Active;
      console.log(`Client ${this.options.clientId} recovered - at least one handler receiving data again`);
      this.options.onRecovered(this.options.clientId);
    }
  }
  
  private handleCompleted(handlerId: string): void {
    this.checkIfCompleted();
  }
  
  private checkIfCompleted(): void {
    // Only check if we're not in a terminal state
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    // Check if ALL handlers are complete
    const allComplete = Array.from(this.handlers.values()).every(
      handler => handler.getState() === State.Completed
    );
    
    if (allComplete && this.handlers.size > 0) {
      this.state = State.Completed;
      const stats = this.getStats();
      console.log(`Client ${this.options.clientId} completed successfully - received ${stats.totalReceived}/${stats.totalExpected} items`);
      
      // Notify manager
      this.options.onCompleted();
      
      // Resolve the completion promise
      this.complete();
    }
  }

  private handleFailed(handlerId: string, error: Error): void {
    // If any handler fails, the client fails
    if (this.state !== State.Failed) {
      this.state = State.Failed;
      console.error(`Client ${this.options.clientId} failed due to handler ${handlerId}: ${error.message}`);
      
      // Notify manager
      this.options.onFailed(error);
      
      // Reject the completion promise
      this.fail(error);
    }
  }
}