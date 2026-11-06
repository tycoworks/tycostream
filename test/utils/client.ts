import { ApolloClient, InMemoryCache } from '@apollo/client';
import { YogaLink } from '@graphql-yoga/apollo-link';
import { createSubscriptionHandler } from './subscription';
import { EventHandler, Stats } from './events';
import { StateManager, StatefulItem, State } from './state';
import { GraphQLEndpoint } from './environment';

// Constructor options - just configuration
export interface TestClientOptions {
  clientId: string;
  graphqlEndpoint: GraphQLEndpoint;
  livenessTimeoutMs: number;
}

// Subscription options
export interface SubscriptionOptions<TData = any> {
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>; // Required - what state we expect to reach
}

export class TestClient<TData = any> implements StatefulItem {
  private graphqlClient: ApolloClient;

  // === State Management (public for parent access) ===
  stateManager: StateManager<EventHandler>;

  constructor(private options: TestClientOptions) {
    // Create Apollo client that receives subscriptions over SSE
    const { host, port, path } = options.graphqlEndpoint;

    this.graphqlClient = new ApolloClient({
      link: new YogaLink({ endpoint: `http://${host}:${port}${path}` }),
      cache: new InMemoryCache(),
    });

    // Initialize state manager
    this.stateManager = new StateManager<EventHandler>(
      `Client ${options.clientId}`,
      false, // Don't fail on stall
    );
  }

  // === Public Methods ===

  async subscribe(
    id: string,
    options: SubscriptionOptions<TData>,
  ): Promise<void> {
    if (this.stateManager.has(id)) {
      throw new Error(
        `Client ${this.options.clientId}: Handler '${id}' already exists`,
      );
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
      onStateChange: () => this.handleStateChange(),
      livenessTimeoutMs: this.options.livenessTimeoutMs,
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
      Array.from(handlers.values()).map((handler) => handler.dispose()),
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
      totalReceived,
    };
  }

  // === Private Methods ===

  private handleStateChange(): void {
    const oldState = this.stateManager.getState();
    this.stateManager.handleChildStateChange();
    const newState = this.stateManager.getState();

    // Log completion with stats
    if (oldState !== newState && newState === State.Completed) {
      const stats = this.getStats();
      console.log(
        `Client ${this.options.clientId} completed - received ${stats.totalReceived}/${stats.totalExpected} items`,
      );
    }
    // Parent notification happens automatically via StateManager chain
  }
}
