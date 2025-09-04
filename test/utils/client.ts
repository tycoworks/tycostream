import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { SubscriptionHandler } from './subscription';
import { TriggerHandler } from './trigger';
import { EventStreamHandler, HandlerCallbacks } from './handler';
import { State } from './tracker';

// GraphQL endpoint configuration
export interface GraphQLEndpoint {
  host: string;  // e.g., "localhost"
  port: number;  // e.g., 4001
  path: string;  // e.g., "/graphql"
}

// Constructor options - just configuration and callbacks
export interface TestClientOptions {
  clientId: string;
  graphqlEndpoint: GraphQLEndpoint;
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
  private graphqlClient: ApolloClient;
  
  // === Handlers ===
  private handlers = new Map<string, EventStreamHandler>();
  
  // === Lifecycle State ===
  private finished = false;
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
    const handler = new SubscriptionHandler<TData>({
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
    const handler = new TriggerHandler<TData>({
      id,
      clientId: this.options.clientId,
      query: options.query,
      idField: options.idField,
      expectedEvents: options.expectedEvents,
      createWebhook: this.options.createWebhook,
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

  dispose() {
    // Dispose all handlers
    for (const handler of this.handlers.values()) {
      handler.dispose();
    }
    this.handlers.clear();
  }

  get stats() {
    let totalReceived = 0;
    
    for (const handler of this.handlers.values()) {
      const stats = handler.getStats();
      totalReceived += stats.totalReceived;
    }
    
    // Check if any handler is stalled
    const isStalled = Array.from(this.handlers.values()).some(
      handler => handler.getState() === State.Stalled
    );
    
    return {
      clientId: this.options.clientId,
      stateSize: totalReceived,
      isFinished: this.finished,
      isStalled
    };
  }

  // === Private Methods ===

  private createHandlerCallbacks(): HandlerCallbacks {
    return {
      onStalled: (handlerId) => this.handleStalled(handlerId),
      onRecovered: (handlerId) => this.handleRecovered(handlerId),
      onCompleted: (handlerId) => this.handleCompleted(handlerId),
      onError: (error) => this.handleError(error)
    };
  }

  private handleStalled(handlerId: string): void {
    // Check if ALL handlers are now stalled
    const allStalled = Array.from(this.handlers.values()).every(
      handler => handler.getState() === State.Stalled
    );
    
    // Only notify if ALL handlers are stalled
    if (allStalled) {
      console.log(`Client ${this.options.clientId} stalled - all handlers stopped receiving data`);
      this.options.onStalled(this.options.clientId);
    }
  }
  
  private handleRecovered(handlerId: string): void {
    // Check if we were stalled before this recovery
    // We need to check all OTHER handlers (not including this one that just recovered)
    const wasStalled = Array.from(this.handlers.entries()).every(
      ([id, handler]) => id === handlerId || handler.getState() === State.Stalled
    );
    
    // Only notify if we're recovering from a fully stalled state
    if (wasStalled) {
      console.log(`Client ${this.options.clientId} recovered - at least one handler receiving data again`);
      this.options.onRecovered(this.options.clientId);
    }
  }
  
  private handleCompleted(handlerId: string): void {
    this.checkIfFinished();
  }
  
  private checkIfFinished(): void {
    if (this.finished) return;
    
    // Check if ALL handlers are complete
    const allComplete = Array.from(this.handlers.values()).every(
      handler => handler.getState() === State.Completed
    );
    
    if (allComplete && this.handlers.size > 0) {
      this.finished = true;
      console.log(`Client ${this.options.clientId} finished successfully - state size: ${this.stats.stateSize}`);
      
      // Notify manager
      this.options.onFinished();
      
      // Resolve the completion promise
      this.complete();
    }
  }

  private handleError(error: Error) {
    this.finished = true; // Prevent further processing
    this.fail(error);
  }
}