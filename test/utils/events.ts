import { ApolloClient } from '@apollo/client';
import { State } from './tracker';

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
 * Interface for handling event streams from various sources (GraphQL subscriptions, webhooks, etc.)
 * Handlers are responsible for:
 * 1. Setting up the event source (WebSocket, webhook, etc.)
 * 2. Parsing transport-specific data formats
 * 3. Managing their own state lifecycle through HandlerStateTracker
 */
export interface EventStreamHandler {
  /**
   * Start the event stream (subscribe to WebSocket, register webhook, etc.)
   * Can be called multiple times safely - will return the same promise
   * @returns Promise that resolves when the stream is established
   */
  start(): Promise<void>;
  
  /**
   * Get the current state of the handler
   */
  getState(): State;
  
  /**
   * Get statistics about received vs expected data
   */
  getStats(): Stats;
  
  /**
   * Clean up any resources (unsubscribe, close connections, etc.)
   */
  dispose(): Promise<void>;
}