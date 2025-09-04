/**
 * State lifecycle for event handlers
 */
export enum State {
  Active = 'active',
  Stalled = 'stalled',
  Completed = 'completed',
  Failed = 'failed'
}

/**
 * Statistics for progress tracking
 */
export interface Stats {
  totalExpected: number;
  totalReceived: number;
}

/**
 * Interface for processing events and checking completion
 * Different implementations for different event patterns (Map vs List)
 */
export interface EventProcessor<TData = any> {
  /**
   * Process an incoming event
   */
  processEvent(data: any): void;
  
  /**
   * Check if we've reached the expected completion state
   */
  isComplete(): boolean;
  
  /**
   * Get statistics about processed events
   */
  getStats(): Stats;
}

/**
 * Interface for event sources (GraphQL subscriptions, webhooks, etc.)
 * Handles setting up the transport and delivering events via callback
 */
export interface EventStream<TData = any> {
  /**
   * Subscribe to the stream with event handlers
   * @param onData Handler for data events
   * @param onError Optional handler for errors
   */
  subscribe(
    onData: (data: TData) => void,
    onError?: (error: Error) => void
  ): Promise<void>;
  
  /**
   * Unsubscribe from the stream and clean up resources
   */
  unsubscribe(): Promise<void>;
}

/**
 * Callbacks for lifecycle events
 */
export interface HandlerCallbacks {
  // State management callbacks
  onStalled: (handlerId: string) => void;
  onRecovered: (handlerId: string) => void;
  onCompleted: (handlerId: string) => void;
  onFailed: (handlerId: string, error: Error) => void;
}

/**
 * Configuration for EventHandler
 */
export interface EventHandlerConfig {
  id: string;                         // Handler ID for logging
  clientId: string;                   // Client ID for logging
  callbacks: HandlerCallbacks;        // Lifecycle callbacks
  livenessTimeoutMs: number;          // Timeout for liveness checking
}

import { StatefulItem } from './state';

/**
 * Event handler that works with any EventStream and EventProcessor
 * Manages state lifecycle, liveness checking, and coordinates between stream and processor
 */
export class EventHandler<TData = any> implements StatefulItem {
  private startPromise?: Promise<void>;
  
  // State tracking fields
  private state: State = State.Active;
  private livenessTimer?: NodeJS.Timeout;
  
  constructor(
    private stream: EventStream<any>,
    private processor: EventProcessor<TData>,
    private config: EventHandlerConfig
  ) {
    // Start the liveness timer immediately
    this.resetLivenessTimer();
  }
  
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    return this.startPromise;
  }
  
  private async doStart(): Promise<void> {
    // Subscribe to the stream
    await this.stream.subscribe(
      (data) => {
        // Process the event data
        this.processEvent(data);
      },
      async (error) => {
        // Stream error - mark as failed
        this.markFailed();
        await this.cleanup();
        this.config.callbacks.onFailed(this.config.id, error);
      }
    );
  }
  
  private async processEvent(data: any): Promise<void> {
    // Record activity for liveness tracking
    this.recordActivity();
    
    try {
      // Delegate processing to the processor
      this.processor.processEvent(data);
      
      // Check if we're finished after state update
      if (this.processor.isComplete()) {
        this.markCompleted();
        await this.cleanup();
        this.config.callbacks.onCompleted(this.config.id);
      }
    } catch (error) {
      // If processing fails, mark as failed
      this.markFailed();
      await this.cleanup();
      this.config.callbacks.onFailed(this.config.id, new Error(`Handler ${this.config.id} failed`));
    }
  }
  
  getState(): State {
    return this.state;
  }
  
  getStats(): Stats {
    return this.processor.getStats();
  }
  
  private isInTerminalState(): boolean {
    return this.state === State.Completed || this.state === State.Failed;
  }
  
  private async cleanup(): Promise<void> {
    console.log(`Cleaning up ${this.config.id}`);
    await this.stream.unsubscribe();
  }
  
  async dispose(): Promise<void> {
    this.clearLivenessTimer();
    await this.cleanup();
  }
  
  // State transition methods
  private recordActivity(): void {
    // Can't record activity if we're in a terminal state
    if (this.isInTerminalState()) return;
    
    // If we were stalled, recover
    if (this.state === State.Stalled) {
      this.state = State.Active;
      console.log(`${this.config.id} for client ${this.config.clientId} recovered`);
      this.config.callbacks.onRecovered(this.config.id);
    }
    
    this.resetLivenessTimer();
  }
  
  private markCompleted(): void {
    if (this.isInTerminalState()) return;
    
    this.clearLivenessTimer();
    this.state = State.Completed;
    console.log(`${this.config.id} for client ${this.config.clientId} completed`);
    // Note: cleanup is called separately
  }
  
  private markFailed(): void {
    if (this.isInTerminalState()) return;
    
    this.clearLivenessTimer();
    this.state = State.Failed;
    // Note: error is already logged by the caller
  }
  
  // Liveness timeout methods
  private resetLivenessTimer(): void {
    this.clearLivenessTimer();
    
    this.livenessTimer = setTimeout(() => {
      if (this.state === State.Active) {
        this.state = State.Stalled;
        console.log(`${this.config.id} for client ${this.config.clientId} stalled`);
        this.config.callbacks.onStalled(this.config.id);
      }
    }, this.config.livenessTimeoutMs);
  }
  
  private clearLivenessTimer(): void {
    if (this.livenessTimer) {
      clearTimeout(this.livenessTimer);
      this.livenessTimer = undefined;
    }
  }
}