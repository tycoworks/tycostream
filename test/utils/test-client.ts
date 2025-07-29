import { createClient, Client as WSClient } from 'graphql-ws';
import * as WebSocket from 'ws';

export interface TestClientOptions<TData = any> {
  clientId: string; // Required - TestClientManager will populate with randomUUID
  appPort: number;
  query: string;
  dataPath: string; // Path to data in GraphQL response, e.g. "users" or "all_types"
  idField: string; // Field name for ID in the data (e.g., "id", "user_id")
  expectedState: Map<string | number, TData>; // Required - what state we expect to reach
  livenessTimeoutMs: number; // How long without data before marking as stalled
  onOperation: (operation: string, data: TData) => void; // Callback for each operation
  onFinished: () => void;
  onStalled: (clientId: string) => void;
  onRecovered: (clientId: string) => void;
}

export class TestClient<TData = any> {
  private client: WSClient;
  private currentState = new Map<string | number, TData>();
  private eventCount = 0;
  private lastEventTime = Date.now();
  private finished = false;
  private stalled = false;
  private livenessTimeout?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private completionPromise: Promise<void>;
  private resolveCompletion!: () => void;
  private rejectCompletion!: (error: Error) => void;
  private idField: string;

  constructor(private options: TestClientOptions<TData>) {
    this.client = this.createWebSocketClient(options.appPort);
    this.idField = options.idField;
    
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
        error: (error: any) => {
          const errorMessage = error?.message || error?.toString() || 'Unknown error';
          console.error(`Client ${this.options.clientId} subscription error:`, errorMessage);
          this.handleError(new Error(`Client ${this.options.clientId} subscription error: ${errorMessage}`));
        },
        complete: () => {
          // Stream closed - this is an error condition
          const expectedSize = this.options.expectedState.size;
          const error = this.finished 
            ? new Error(`Client ${this.options.clientId} stream closed unexpectedly after completion`)
            : new Error(`Client ${this.options.clientId} stream closed prematurely - events: ${this.eventCount}, state size: ${this.currentState.size}, expected: ${expectedSize}`);
          this.handleError(error);
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
      this.options.onRecovered(this.options.clientId);
    }
    
    this.resetLiveness();

    // Extract operation and data from standard GraphQL response structure
    const responseData = data.data[this.options.dataPath];
    if (!responseData) return;
    
    const { operation, data: rowData, fields } = responseData;
    
    // Notify callback
    this.options.onOperation(operation, rowData);
    
    // Update state based on operation
    if (!rowData) {
      throw new Error(`Received ${operation} operation without data`);
    }
    
    const id = rowData[this.idField];
    
    switch (operation) {
      case 'DELETE':
        this.currentState.delete(id);
        break;
        
      case 'INSERT':
        this.currentState.set(id, rowData);
        break;
        
      case 'UPDATE': {
        // UPDATE only has changed fields + primary key - merge with existing
        const existingRow = this.currentState.get(id);
        if (!existingRow) {
          throw new Error(`UPDATE for non-existent row with ${this.idField}=${id}`);
        }
        
        // Only update fields that are actually present in the update
        const updatedRow = { ...existingRow };
        for (const field of fields) {
          updatedRow[field] = rowData[field];
        }
        
        this.currentState.set(id, updatedRow);
        break;
      }
    }

    // Check if we're finished on EVERY update
    if (!this.finished) {
      this.checkIfFinished();
    }
  }
  
  private checkIfFinished() {
    const isFinished = this.areStatesEqual(this.currentState, this.options.expectedState);
      
    if (isFinished) {
      this.finished = true;
      console.log(`Client ${this.options.clientId} finished successfully - events: ${this.eventCount}, state size: ${this.currentState.size}`);
      
      this.clearLivenessTimeout();
      
      // Notify manager
      this.options.onFinished();
      
      // Resolve the completion promise
      this.resolveCompletion();
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
      const timeoutMs = this.options.livenessTimeoutMs;
      this.livenessTimeout = setTimeout(() => {
        // Don't error out - just mark as stalled and notify manager
        this.stalled = true;
        const expectedSize = this.options.expectedState.size;
        console.warn(`Client ${this.options.clientId} stalled - no messages for ${timeoutMs}ms. Events: ${this.eventCount}, State size: ${this.currentState.size}/${expectedSize}`);
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
  
  private createWebSocketClient(port: number): WSClient {
    return createClient({
      url: `ws://localhost:${port}/graphql`,
      webSocketImpl: WebSocket as any,
    });
  }

  /**
   * Compare two state maps for equality
   */
  private areStatesEqual<T>(
    currentState: Map<string | number, T>,
    expectedState: Map<string | number, T>
  ): boolean {
    if (currentState.size !== expectedState.size) {
      return false;
    }
    
    for (const [id, expectedData] of expectedState) {
      const currentData = currentState.get(id);
      if (!currentData || JSON.stringify(currentData) !== JSON.stringify(expectedData)) {
        return false;
      }
    }
    
    return true;
  }
}