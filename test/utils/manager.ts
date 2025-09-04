import { TestClient, GraphQLEndpoint } from './client';

export class TestClientManager<TData = any> {
  // === Client Management ===
  private clients = new Map<string, TestClient<TData>>();
  
  // === Configuration ===
  private livenessTimeoutMs: number;
  private graphqlEndpoint: GraphQLEndpoint;
  private createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
  
  // === Lifecycle State ===
  private finishedCount = 0;
  private stalledClients = new Set<string>();
  private completionPromise: Promise<void>;
  private complete!: () => void;
  private fail!: (error: Error) => void;

  constructor(
    graphqlEndpoint: GraphQLEndpoint,
    createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string,
    livenessTimeoutMs: number = 30000
  ) {
    this.graphqlEndpoint = graphqlEndpoint;
    this.createWebhook = createWebhook;
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

    // Store the client
    this.clients.set(id, client);
    console.log(`Created client '${id}' (${this.clients.size} total clients)`);
    
    // Track completion
    client.waitForCompletion().catch(error => {
      console.error(`Client ${id} error:`, error.message);
      this.checkIfAllStalled();
    });
    
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
      ...client.stats,
      clientId: id
    }));
  }
}