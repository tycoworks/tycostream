import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { SubscriptionHandler } from './subscription';
import { TriggerHandler } from './trigger';
import { HandlerCallbacks } from './handler';

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
  private subscriptionHandler?: SubscriptionHandler<TData>;
  private subscriptionOptions?: SubscriptionOptions<TData>;

  private triggerHandler?: TriggerHandler<TData>;
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
      // Create handler with expected state and callbacks
      this.subscriptionHandler = new SubscriptionHandler<TData>({
        clientId: this.options.clientId,
        query: this.subscriptionOptions.query,
        dataPath: this.subscriptionOptions.dataPath,
        idField: this.subscriptionOptions.idField,
        expectedState: this.subscriptionOptions.expectedState,
        callbacks: this.createHandlerCallbacks()
      });
      
      // Start the subscription
      await this.subscriptionHandler.start(this.graphqlClient);
    }
    
    // Set up webhook and execute trigger mutation if configured
    if (this.triggerOptions) {
      // Create handler with expected events and callbacks
      this.triggerHandler = new TriggerHandler<TData>({
        clientId: this.options.clientId,
        query: this.triggerOptions.query,
        idField: this.triggerOptions.idField,
        expectedEvents: this.triggerOptions.expectedEvents,
        createWebhook: this.options.createWebhook,
        callbacks: this.createHandlerCallbacks()
      });
      
      // Start the trigger (register webhook and execute mutation)
      await this.triggerHandler.start(this.graphqlClient);
    }
    
    // All setup is complete (subscription and/or webhook), mark as ready
    this.readyResolve();
    
    // Return the ready promise (resolves when client is ready)
    return this.readyPromise;
  }
  
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  dispose() {
    this.clearLivenessTimeout();
    if (this.subscriptionHandler) {
      this.subscriptionHandler.dispose();
    }
    if (this.triggerHandler) {
      this.triggerHandler.dispose();
    }
  }

  get stats() {
    // Combine stats from both handlers
    const subStats = this.subscriptionHandler?.getStats() || { totalReceived: 0 };
    const triggerStats = this.triggerHandler?.getStats() || { totalReceived: 0 };
    
    return {
      eventCount: this.eventCount,
      stateSize: subStats.totalReceived + triggerStats.totalReceived,
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
    const subscriptionComplete = !this.subscriptionHandler || this.subscriptionHandler.isComplete();
    const triggerComplete = !this.triggerHandler || this.triggerHandler.isComplete();
    
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
}