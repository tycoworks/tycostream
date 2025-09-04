import { TestClient } from './client';
import { Stats } from './events';
import { State, StateManager, StatefulItem } from './state';
import { GraphQLEndpoint } from './environment';
import { WebhookEndpoint } from './webhook';

export class TestClientManager<TData = any> implements StatefulItem {
  // === State Management ===
  private stateManager: StateManager<TestClient<TData>>;
  
  // === Configuration ===
  private livenessTimeoutMs: number;
  private graphqlEndpoint: GraphQLEndpoint;
  private webhookEndpoint: WebhookEndpoint;

  constructor(
    graphqlEndpoint: GraphQLEndpoint,
    webhookEndpoint: WebhookEndpoint,
    livenessTimeoutMs: number = 30000
  ) {
    this.graphqlEndpoint = graphqlEndpoint;
    this.webhookEndpoint = webhookEndpoint;
    this.livenessTimeoutMs = livenessTimeoutMs;
    
    // Initialize state manager
    this.stateManager = new StateManager<TestClient<TData>>(
      'Manager',
      true  // Fail on stall
    );
  }


  async waitForCompletion(): Promise<void> {
    // Wait for all clients to finish
    return this.stateManager.waitForCompletion();
  }
  
  getState(): State {
    return this.stateManager.getState();
  }

  createClient(id: string): TestClient<TData> {
    // Create new client
    const client = new TestClient<TData>({
      clientId: id,
      graphqlEndpoint: this.graphqlEndpoint,
      webhookEndpoint: this.webhookEndpoint,
      livenessTimeoutMs: this.livenessTimeoutMs,
      onCompleted: () => this.stateManager.handleChildStateChange(),
      onFailed: (error: Error) => this.stateManager.handleChildStateChange(),
      onStalled: (clientId: string) => this.stateManager.handleChildStateChange(),
      onRecovered: (clientId: string) => this.stateManager.handleChildStateChange()
    });

    // Add to state manager
    this.stateManager.add(id, client);
    console.log(`Created client '${id}' (${this.stateManager.getItems().size} total clients)`);
    
    // Track completion (for catching unexpected errors)
    client.waitForCompletion().catch(error => {
      // This should rarely happen since we handle failures via onFailed callback
      console.error(`Unexpected error from client ${id}: ${error.message}`);
    });
    
    return client;
  }

  async dispose(): Promise<void> {
    const clients = this.stateManager.getItems();
    await Promise.all(
      Array.from(clients.values()).map(client => client.dispose())
    );
  }

  getStats(): Stats {
    let totalExpected = 0;
    let totalReceived = 0;
    
    const clients = this.stateManager.getItems();
    for (const client of clients.values()) {
      const stats = client.getStats();
      totalExpected += stats.totalExpected;
      totalReceived += stats.totalReceived;
    }
    
    return {
      totalExpected,
      totalReceived
    };
  }
}