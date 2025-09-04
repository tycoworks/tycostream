import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
import { GraphQLWsLink } from '@apollo/client/link/subscriptions';
import { createClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { createSubscriptionHandler } from './subscription';
import { createTriggerHandler } from './trigger';
import { EventHandler, HandlerCallbacks, Stats, State } from './events';
import { StateManager, StatefulItem } from './state';
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

export class TestClient<TData = any> implements StatefulItem {
  private graphqlClient: ApolloClient;
  
  // === State Management ===
  private stateManager: StateManager<EventHandler>;

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
    
    // Initialize state manager
    this.stateManager = new StateManager<EventHandler>(
      `Client ${options.clientId}`,
      false  // Don't fail on stall
    );
  }

  // === Public Methods ===
  
  async subscribe(id: string, options: SubscriptionOptions<TData>): Promise<void> {
    if (this.stateManager.has(id)) {
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
    this.stateManager.add(id, handler);
  }
  
  async trigger(id: string, options: TriggerOptions<TData>): Promise<void> {
    if (this.stateManager.has(id)) {
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
    this.stateManager.add(id, handler);
  }
  
  async waitForCompletion(): Promise<void> {
    return this.stateManager.waitForCompletion();
  }

  async dispose(): Promise<void> {
    // Dispose all handlers
    const handlers = this.stateManager.getItems();
    await Promise.all(
      Array.from(handlers.values()).map(handler => handler.dispose())
    );
  }

  getState(): State {
    return this.stateManager.getState();
  }
  
  getStats(): Stats {
    let totalExpected = 0;
    let totalReceived = 0;
    
    const handlers = this.stateManager.getItems();
    for (const handler of handlers.values()) {
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
      onStalled: (handlerId) => this.handleStateChange(),
      onRecovered: (handlerId) => this.handleStateChange(),
      onCompleted: (handlerId) => this.handleStateChange(),
      onFailed: (handlerId, error) => this.handleStateChange()
    };
  }
  
  private handleStateChange(): void {
    const oldState = this.stateManager.getState();
    this.stateManager.handleChildStateChange();
    const newState = this.stateManager.getState();
    
    // Notify parent callbacks if state changed
    if (oldState !== newState) {
      this.notifyParent(oldState, newState);
    }
  }
  
  private notifyParent(oldState: State, newState: State): void {
    switch (newState) {
      case State.Stalled:
        console.log(`Client ${this.options.clientId} stalled - all handlers stopped`);
        this.options.onStalled(this.options.clientId);
        break;
      case State.Active:
        if (oldState === State.Stalled) {
          console.log(`Client ${this.options.clientId} recovered`);
          this.options.onRecovered(this.options.clientId);
        }
        break;
      case State.Completed:
        const stats = this.getStats();
        console.log(`Client ${this.options.clientId} completed - received ${stats.totalReceived}/${stats.totalExpected} items`);
        this.options.onCompleted();
        break;
      case State.Failed:
        console.error(`Client ${this.options.clientId} failed`);
        this.options.onFailed(new Error(`Client ${this.options.clientId} failed`));
        break;
    }
  }
}