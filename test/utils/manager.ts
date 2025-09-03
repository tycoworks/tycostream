import { TestClient } from './client';
import { Client as WSClient } from 'graphql-ws';
import { TestClientConfig } from './environment';

export class TestClientManager<TData = any> {
  // === Client Management ===
  private clients = new Map<string, TestClient<TData>>();
  
  // === Configuration ===
  private livenessTimeoutMs: number;
  private createWebSocketClient: () => WSClient;
  private createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
  
  // === Lifecycle State ===
  private finishedCount = 0;
  private stalledClients = new Set<string>();
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;

  constructor(
    createWebSocketClient: () => WSClient,
    createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string,
    livenessTimeoutMs: number = 30000
  ) {
    this.createWebSocketClient = createWebSocketClient;
    this.createWebhook = createWebhook;
    this.livenessTimeoutMs = livenessTimeoutMs;
    this.completionPromise = new Promise((complete, fail) => {
      this.complete = complete;
      this.fail = fail;
    });
  }

  async startClient(config: TestClientConfig<TData>): Promise<void> {
    if (this.clients.has(config.id)) {
      throw new Error(`Client ${config.id} already started`);
    }
    
    // Create, configure, and start the client immediately
    const client = this.createClient(config);
    
    // Start the client and wait for it to be ready (subscription/webhook established)
    await client.start();
    
    // Track completion separately
    client.waitForCompletion().catch(error => {
      // Client errored out - check if we should fail the test
      console.error(`Client ${config.id} error:`, error.message);
      this.checkIfAllStalled();
    });
  }

  async waitForCompletion(): Promise<void> {
    // Wait for all clients to finish
    return this.completionPromise;
  }

  private createClient(config: TestClientConfig<TData>): TestClient<TData> {
    // Create new client
    const client = new TestClient<TData>({
      clientId: config.id,
      createWebSocketClient: this.createWebSocketClient,
      createWebhook: this.createWebhook,
      livenessTimeoutMs: this.livenessTimeoutMs,
      onFinished: () => {
        this.onClientFinished();
      },
      onStalled: (clientId: string) => {
        this.onClientStalled(clientId);
      },
      onRecovered: (clientId: string) => {
        this.onClientRecovered(clientId);
      }
    });

    // Configure the client
    if (config.subscription) {
      client.configureSubscription(config.subscription);
    }
    if (config.trigger) {
      client.configureTrigger(config.trigger);
    }

    // Store the client
    this.clients.set(config.id, client);
    console.log(`Created client '${config.id}' (${this.clients.size} total clients)`);
    
    return client;
  }

  private onClientFinished() {
    this.finishedCount++;
    console.log(`Progress: ${this.finishedCount}/${this.clients.size} clients finished`);
    
    if (this.finishedCount === this.clients.size) {
      this.complete();
    }
  }
  
  private onClientStalled(clientId: string) {
    this.stalledClients.add(clientId);
    console.warn(`Client ${clientId} stalled. Total stalled: ${this.stalledClients.size}/${this.clients.size}`);
    this.checkIfAllStalled();
  }
  
  private onClientRecovered(clientId: string) {
    this.stalledClients.delete(clientId);
    console.log(`Client ${clientId} recovered! Remaining stalled: ${this.stalledClients.size}`);
  }
  
  private checkIfAllStalled() {
    const stats = this.stats;
    const activeClients = stats.filter(s => !s.isFinished && !s.isStalled);
    const finishedCount = stats.filter(s => s.isFinished).length;
    
    // Check if ALL unfinished clients are stalled
    if (activeClients.length === 0 && finishedCount < this.clients.size) {
      const summary = stats.map(s => 
        `Client ${s.clientId}: ${s.eventCount} events, ${s.stateSize} rows, ${s.isFinished ? 'finished' : s.isStalled ? 'STALLED' : 'active'}`
      ).join('\n  ');
      
      this.fail(new Error(
        `All active clients are stalled! No data flowing to any client.\n  ${summary}`
      ));
    }
  }

  dispose() {
    this.clients.forEach(client => client.dispose());
  }

  get stats() {
    return Array.from(this.clients.entries()).map(([id, client]) => ({
      clientId: id,
      ...client.stats
    }));
  }
}