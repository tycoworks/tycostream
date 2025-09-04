import { ApolloClient } from '@apollo/client';
import { State } from './tracker';

/**
 * Callbacks for lifecycle events
 */
export interface HandlerCallbacks {
  // State management callbacks
  onStalled: (handlerId: string) => void;
  onRecovered: (handlerId: string) => void;
  onCompleted: (handlerId: string) => void;
  
  // Error callback
  onError: (error: Error) => void;
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
   * @returns Object with totalExpected and totalReceived
   */
  getStats(): {
    totalExpected: number;
    totalReceived: number;
  };
  
  /**
   * Clean up any resources (unsubscribe, close connections, etc.)
   */
  dispose(): void;
}