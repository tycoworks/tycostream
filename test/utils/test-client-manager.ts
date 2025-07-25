import { TestClient } from './test-client';

export interface StartClientOptions<TData = any> {
  query: string;
  expectedState: Map<string | number, TData>;
  dataPath: string;
  idField: string;
  onOperation: (operation: string, data: TData) => void;
}

export class TestClientManager<TData = any> {
  private clients: TestClient[] = [];
  private finishedCount = 0;
  private stalledClients = new Set<string>();
  private allFinishedPromise: Promise<void>;
  private resolveAllFinished!: () => void;
  private rejectAllFinished!: (error: Error) => void;
  private expectedClientCount: number = 0;
  private port: number;
  private livenessTimeoutMs: number;
  private nextClientId: number = 1;

  constructor(port: number, livenessTimeoutMs: number) {
    this.port = port;
    this.livenessTimeoutMs = livenessTimeoutMs;
    this.allFinishedPromise = new Promise((resolve, reject) => {
      this.resolveAllFinished = resolve;
      this.rejectAllFinished = reject;
    });
  }

  async startClient(options: StartClientOptions<TData>): Promise<void> {
    const clientId = `client-${this.nextClientId++}`;
    this.expectedClientCount++;
    
    const client = new TestClient<TData>({
      clientId,
      appPort: this.port,
      livenessTimeoutMs: this.livenessTimeoutMs,
      ...options,
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

    this.clients.push(client);
    
    // Start the subscription (doesn't wait for completion)
    await client.startSubscription();
    
    // Track completion in background
    client.waitForCompletion().catch(error => {
      // Client errored out - check if we should fail the test
      console.error(`Client error:`, error.message);
      this.checkIfAllStalled();
    });
  
    console.log(`Started client ${this.clients.length}/${this.expectedClientCount} with ID ${clientId}`);
  }

  async startClients(
    numClients: number,
    staggerDelayMs: number,
    options: StartClientOptions<TData>
  ): Promise<void> {
    for (let i = 0; i < numClients; i++) {
      await this.startClient(options);
      
      // Wait before starting next client if requested
      if (staggerDelayMs > 0 && i < numClients - 1) {
        await new Promise(resolve => setTimeout(resolve, staggerDelayMs));
      }
    }
  }

  private onClientFinished() {
    this.finishedCount++;
    console.log(`Progress: ${this.finishedCount}/${this.expectedClientCount} clients finished`);
    
    if (this.finishedCount === this.expectedClientCount) {
      this.resolveAllFinished();
    }
  }
  
  private onClientStalled(clientId: string) {
    this.stalledClients.add(clientId);
    console.warn(`Client ${clientId} stalled. Total stalled: ${this.stalledClients.size}/${this.clients.length}`);
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
    if (activeClients.length === 0 && finishedCount < this.clients.length) {
      const summary = stats.map(s => 
        `Client ${s.clientId}: ${s.eventCount} events, ${s.stateSize} rows, ${s.isFinished ? 'finished' : s.isStalled ? 'STALLED' : 'active'}`
      ).join('\n  ');
      
      this.rejectAllFinished(new Error(
        `All active clients are stalled! No data flowing to any client.\n  ${summary}`
      ));
    }
  }

  async waitForCompletion(): Promise<void> {
    // Simply wait for all clients to finish
    // TestClient handles its own timeouts
    await this.allFinishedPromise;
  }


  dispose() {
    this.clients.forEach(client => client.dispose());
  }

  get stats() {
    return this.clients.map((client, index) => ({
      clientId: index,
      ...client.stats
    }));
  }
  
  getClient(index: number): TestClient {
    return this.clients[index];
  }
}