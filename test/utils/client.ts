import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { SubscriptionHandler } from './subscription';
import { TriggerHandler } from './trigger';
import { EventStreamHandler, HandlerCallbacks } from './handler';

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
  private stalled = false;
  private eventCount = 0;
  private lastEventTime = Date.now();
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;
  
  // === Liveness Tracking ===
  private livenessTimeout?: NodeJS.Timeout;

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
    
    // Start liveness monitoring if this is the first handler
    if (this.handlers.size === 0) {
      this.resetLiveness();
    }
    
    // Create and start subscription handler
    const handler = new SubscriptionHandler<TData>({
      clientId: this.options.clientId,
      query: options.query,
      dataPath: options.dataPath,
      idField: options.idField,
      expectedState: options.expectedState,
      graphqlClient: this.graphqlClient,
      callbacks: this.createHandlerCallbacks()
    });
    
    await handler.start();
    this.handlers.set(id, handler);
  }
  
  async trigger(id: string, options: TriggerOptions<TData>): Promise<void> {
    if (this.handlers.has(id)) {
      throw new Error(`Client ${this.options.clientId}: Handler '${id}' already exists`);
    }
    
    // Start liveness monitoring if this is the first handler
    if (this.handlers.size === 0) {
      this.resetLiveness();
    }
    
    // Create and start trigger handler
    const handler = new TriggerHandler<TData>({
      clientId: this.options.clientId,
      query: options.query,
      idField: options.idField,
      expectedEvents: options.expectedEvents,
      createWebhook: this.options.createWebhook,
      graphqlClient: this.graphqlClient,
      callbacks: this.createHandlerCallbacks()
    });
    
    await handler.start();
    this.handlers.set(id, handler);
  }
  
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  dispose() {
    this.clearLivenessTimeout();
    
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
    
    return {
      clientId: this.options.clientId,
      eventCount: this.eventCount,
      stateSize: totalReceived,
      lastEventTime: this.lastEventTime,
      isFinished: this.finished,
      isStalled: this.stalled
    };
  }

  // === Private Methods ===

  private createHandlerCallbacks(): HandlerCallbacks {
    return {
      onDataReceived: () => this.handleDataReceived(),
      onCheckFinished: () => this.checkIfFinished(),
      onError: (error) => this.handleError(error)
    };
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
    
    // Check if ALL handlers are complete
    const allComplete = Array.from(this.handlers.values()).every(handler => handler.isComplete());
    
    if (allComplete && this.handlers.size > 0) {
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
}