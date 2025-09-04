import { TestClient } from './client';
import { State } from './tracker';
import { Stats } from './handler';
import { GraphQLEndpoint } from './environment';
import { WebhookEndpoint } from './webhook';

export class TestClientManager<TData = any> {
  // === Client Management ===
  private clients = new Map<string, TestClient<TData>>();
  
  // === Configuration ===
  private livenessTimeoutMs: number;
  private graphqlEndpoint: GraphQLEndpoint;
  private webhookEndpoint: WebhookEndpoint;
  
  // === Lifecycle State ===
  private state: State = State.Active;
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;

  constructor(
    graphqlEndpoint: GraphQLEndpoint,
    webhookEndpoint: WebhookEndpoint,
    livenessTimeoutMs: number = 30000
  ) {
    this.graphqlEndpoint = graphqlEndpoint;
    this.webhookEndpoint = webhookEndpoint;
    this.livenessTimeoutMs = livenessTimeoutMs;
    this.completionPromise = new Promise((complete, fail) => {
      this.complete = complete;
      this.fail = fail;
    });
  }


  async waitForCompletion(): Promise<void> {
    // Wait for all clients to finish
    return this.completionPromise;
  }

  createClient(id: string): TestClient<TData> {
    if (this.clients.has(id)) {
      throw new Error(`Client ${id} already exists`);
    }
    
    // Create new client
    const client = new TestClient<TData>({
      clientId: id,
      graphqlEndpoint: this.graphqlEndpoint,
      webhookEndpoint: this.webhookEndpoint,
      livenessTimeoutMs: this.livenessTimeoutMs,
      onCompleted: () => {
        this.onClientCompleted();
      },
      onFailed: (error: Error) => {
        this.onClientFailed(id, error);
      },
      onStalled: (clientId: string) => {
        this.onClientStalled(clientId);
      },
      onRecovered: (clientId: string) => {
        this.onClientRecovered(clientId);
      }
    });

    // Store the client
    this.clients.set(id, client);
    console.log(`Created client '${id}' (${this.clients.size} total clients)`);
    
    // Track completion (for catching unexpected errors)
    client.waitForCompletion().catch(error => {
      // This should rarely happen since we handle failures via onFailed callback
      console.error(`Unexpected error from client ${id}: ${error.message}`);
    });
    
    return client;
  }

  private onClientCompleted() {
    // Only process if not in a terminal state
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    // Check if ALL clients are completed
    const allCompleted = Array.from(this.clients.values()).every(
      client => client.getState() === State.Completed
    );
    
    const finishedCount = Array.from(this.clients.values()).filter(
      client => client.getState() === State.Completed
    ).length;
    
    console.log(`Progress: ${finishedCount}/${this.clients.size} clients completed`);
    
    if (allCompleted) {
      this.state = State.Completed;
      this.complete();
    }
  }
  
  private onClientStalled(clientId: string) {
    // Only process if not in a terminal state
    if (this.state === State.Completed || this.state === State.Failed) return;
    
    // Check if ALL clients are stalled
    const allStalled = Array.from(this.clients.values()).every(
      client => client.getState() === State.Stalled
    );
    
    const stalledCount = Array.from(this.clients.values()).filter(
      client => client.getState() === State.Stalled
    ).length;
    
    console.warn(`Client ${clientId} stalled. Total stalled: ${stalledCount}/${this.clients.size}`);
    
    if (allStalled) {
      this.state = State.Stalled;
      // When all clients are stalled, fail the manager
      this.fail(new Error(`All clients stalled - no data flowing to any client`));
    }
  }
  
  private onClientFailed(clientId: string, error: Error) {
    // If any client fails, the manager fails
    if (this.state !== State.Failed) {
      this.state = State.Failed;
      console.error(`Manager failed due to client ${clientId}: ${error.message}`);
      this.fail(error);
    }
  }
  
  private onClientRecovered(clientId: string) {
    // If we were stalled, we're now active again
    if (this.state === State.Stalled) {
      this.state = State.Active;
      
      const stalledCount = Array.from(this.clients.values()).filter(
        client => client.getState() === State.Stalled
      ).length;
      
      console.log(`Client ${clientId} recovered! Remaining stalled: ${stalledCount}`);
    }
  }
  

  async dispose(): Promise<void> {
    await Promise.all(
      Array.from(this.clients.values()).map(client => client.dispose())
    );
  }

  getStats(): Stats {
    let totalExpected = 0;
    let totalReceived = 0;
    
    for (const client of this.clients.values()) {
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