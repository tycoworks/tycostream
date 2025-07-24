import { Client as WSClient } from 'graphql-ws';
import { createWebSocketClient } from './e2e-test-utils';

export interface TestClientOptions<T> {
  clientId: number;
  appPort: number;
  query: string;
  expectedState: Map<any, any>;
  onUpdate: (data: T, currentState: Map<any, any>) => void;
  isFinished?: (currentState: Map<any, any>, expectedState: Map<any, any>) => boolean;
  livenessTimeoutMs?: number;
  onFinished?: () => void;
  onProgress?: (clientId: number) => void;
  onStalled?: (clientId: number) => void;   // Report when client stalls
  onRecovered?: (clientId: number) => void; // Report when client recovers
}

export class GraphQLTestClient<T> {
  private client: WSClient;
  private currentState = new Map<any, any>();
  private eventCount = 0;
  private lastEventTime = Date.now();
  private finished = false;
  private stalled = false;
  private livenessTimeout?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private completionPromise: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;

  constructor(private options: TestClientOptions<T>) {
    this.client = createWebSocketClient(options.appPort);
    
    // Create the completion promise
    this.completionPromise = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
  }

  // Start the subscription but don't wait for completion
  async startSubscription(): Promise<void> {
    // Start liveness check
    this.resetLiveness();

    this.unsubscribe = this.client.subscribe(
      { query: this.options.query },
      {
        next: (data: any) => {
          this.handleUpdate(data);
        },
        error: (error) => {
          console.error(`Client ${this.options.clientId} subscription error:`, error);
          this.handleError(new Error(`Client ${this.options.clientId} subscription error: ${error}`));
        },
        complete: () => {
          this.handleComplete();
        },
      }
    );
    
    // Return immediately - subscription is set up
  }
  
  // Wait for the client to finish
  async waitForCompletion(): Promise<void> {
    return this.completionPromise;
  }

  private handleUpdate(data: any) {
    this.eventCount++;
    this.lastEventTime = Date.now();
    
    // If we were stalled, report recovery
    if (this.stalled) {
      this.stalled = false;
      console.log(`Client ${this.options.clientId} recovered after stall - resuming with event ${this.eventCount}`);
      if (this.options.onRecovered) {
        this.options.onRecovered(this.options.clientId);
      }
    }
    
    this.resetLiveness();
    
    // Report progress to manager
    if (this.options.onProgress) {
      this.options.onProgress(this.options.clientId);
    }

    // Let the test handle the update
    try {
      this.options.onUpdate(data as T, this.currentState);
    } catch (error) {
      console.error(`Client ${this.options.clientId} error processing update:`, error);
      this.handleError(error as Error);
      return;
    }

    // Check if we're finished on EVERY update
    if (!this.finished) {
      this.checkIfFinished();
    }
  }
  
  private checkIfFinished() {
    const isFinished = this.options.isFinished 
      ? this.options.isFinished(this.currentState, this.options.expectedState)
      : this.currentState.size === this.options.expectedState.size;
      
    if (isFinished) {
      this.finished = true;
      console.log(`Client ${this.options.clientId} finished successfully - events: ${this.eventCount}, state size: ${this.currentState.size}`);
      
      this.clearLivenessTimeout();
      
      // Notify manager if callback provided
      if (this.options.onFinished) {
        this.options.onFinished();
      }
      
      // Resolve the completion promise
      this.resolveCompletion();
    }
  }
  
  private handleComplete() {
    // Subscription completed - this should only happen if the connection is closed
    if (!this.finished) {
      console.error(`Client ${this.options.clientId} subscription completed before receiving all data - events: ${this.eventCount}, state size: ${this.currentState.size}, expected: ${this.options.expectedState.size}`);
      this.handleError(new Error(`Client ${this.options.clientId} completed prematurely - connection closed`));
    }
  }
  
  private handleError(error: Error) {
    this.clearLivenessTimeout();
    this.finished = true; // Prevent further processing
    this.rejectCompletion(error);
  }

  private resetLiveness() {
    this.clearLivenessTimeout();
    if (!this.finished) {
      const timeoutMs = this.options.livenessTimeoutMs || 30000;
      this.livenessTimeout = setTimeout(() => {
        // Don't error out - just mark as stalled and notify manager
        this.stalled = true;
        console.warn(`Client ${this.options.clientId} stalled - no messages for ${timeoutMs}ms. Events: ${this.eventCount}, State size: ${this.currentState.size}/${this.options.expectedState.size}`);
        if (this.options.onStalled) {
          this.options.onStalled(this.options.clientId);
        }
        
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

  dispose() {
    this.clearLivenessTimeout();
    if (this.unsubscribe) {
      this.unsubscribe();
    }
    try {
      this.client.dispose();
    } catch (e) {
      // Ignore disposal errors
    }
  }

  get stats() {
    return {
      eventCount: this.eventCount,
      stateSize: this.currentState.size,
      lastEventTime: this.lastEventTime,
      isFinished: this.finished,
      isStalled: this.stalled
    };
  }
}

// Helper class for managing multiple test clients
export class TestClientManager<T> {
  private clients: GraphQLTestClient<T>[] = [];
  private finishedCount = 0;
  private stalledClients = new Set<number>();
  private allFinishedPromise: Promise<void>;
  private resolveAllFinished!: () => void;
  private rejectAllFinished!: (error: Error) => void;
  private timeoutHandle?: NodeJS.Timeout;
  private globalDeadCheckInterval?: NodeJS.Timeout;

  constructor(private totalClients: number) {
    this.allFinishedPromise = new Promise((resolve, reject) => {
      this.resolveAllFinished = resolve;
      this.rejectAllFinished = reject;
    });
  }

  async createAndStartClient(options: TestClientOptions<T>): Promise<GraphQLTestClient<T>> {
    const client = new GraphQLTestClient({
      ...options,
      onFinished: () => {
        this.onClientFinished();
      },
      onProgress: (clientId: number) => {
        // Normal progress, nothing special needed
      },
      onStalled: (clientId: number) => {
        this.onClientStalled(clientId);
      },
      onRecovered: (clientId: number) => {
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
      this.checkTestHealth();
    });
    
    return client;
  }

  private onClientFinished() {
    this.finishedCount++;
    console.log(`Progress: ${this.finishedCount}/${this.totalClients} clients finished`);
    if (this.finishedCount === this.totalClients) {
      this.clearTimeouts();
      this.resolveAllFinished();
    }
  }
  
  private onClientStalled(clientId: number) {
    this.stalledClients.add(clientId);
    console.warn(`Client ${clientId} stalled. Total stalled: ${this.stalledClients.size}/${this.totalClients}`);
    this.checkTestHealth();
  }
  
  private onClientRecovered(clientId: number) {
    this.stalledClients.delete(clientId);
    console.log(`Client ${clientId} recovered! Remaining stalled: ${this.stalledClients.size}`);
  }
  
  private checkTestHealth() {
    const stats = this.stats;
    const activeClients = stats.filter(s => !s.isFinished && !s.isStalled);
    const stalledCount = this.stalledClients.size;
    const finishedCount = stats.filter(s => s.isFinished).length;
    
    console.log(`Test health check - Active: ${activeClients.length}, Stalled: ${stalledCount}, Finished: ${finishedCount}/${this.totalClients}`);
    
    // Check if ALL unfinished clients are stalled
    if (activeClients.length === 0 && finishedCount < this.totalClients) {
      const summary = stats.map(s => 
        `Client ${s.clientId}: ${s.eventCount} events, ${s.stateSize} rows, ${s.isFinished ? 'finished' : s.isStalled ? 'STALLED' : 'active'}`
      ).join('\n  ');
      
      this.rejectAllFinished(new Error(
        `All active clients are stalled! No data flowing to any client.\n  ${summary}`
      ));
    }
  }

  async waitForCompletion(timeoutMs: number): Promise<void> {
    // Set overall timeout
    this.timeoutHandle = setTimeout(() => {
      const stats = this.stats;
      const summary = stats.map(s => 
        `Client ${s.clientId}: ${s.eventCount} events, ${s.stateSize} rows, ${s.isFinished ? 'finished' : s.isStalled ? 'STALLED' : 'active'}`
      ).join('\n  ');
      
      this.rejectAllFinished(new Error(
        `Test timed out after ${timeoutMs}ms. ${this.finishedCount}/${this.totalClients} clients finished.\n  ${summary}`
      ));
    }, timeoutMs);
    
    // Periodically check test health
    this.globalDeadCheckInterval = setInterval(() => {
      this.checkTestHealth();
    }, 5000);

    try {
      await this.allFinishedPromise;
    } finally {
      this.clearTimeouts();
    }
  }

  private clearTimeouts() {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    if (this.globalDeadCheckInterval) {
      clearInterval(this.globalDeadCheckInterval);
      this.globalDeadCheckInterval = undefined;
    }
  }

  dispose() {
    this.clearTimeouts();
    this.clients.forEach(client => client.dispose());
  }

  get stats() {
    return this.clients.map((client, index) => ({
      clientId: index,
      ...client.stats
    }));
  }
}