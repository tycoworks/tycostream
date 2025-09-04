import { ApolloClient } from '@apollo/client';

/**
 * Callbacks for lifecycle events
 */
export interface HandlerCallbacks {
  // Lifecycle callbacks - called by handler to notify TestClient
  onDataReceived: () => void;      // Called when any data arrives (for liveness tracking)
  onCheckFinished: () => void;      // Called after processing to check completion
  onError: (error: Error) => void;
}

/**
 * Interface for handling event streams from various sources (GraphQL subscriptions, webhooks, etc.)
 * Handlers are responsible for:
 * 1. Setting up the event source (WebSocket, webhook, etc.)
 * 2. Parsing transport-specific data formats
 * 3. Calling the appropriate callbacks in the correct order
 */
export interface EventStreamHandler {
  /**
   * Start the event stream (subscribe to WebSocket, register webhook, etc.)
   * Can be called multiple times safely - will return the same promise
   * @returns Promise that resolves when the stream is established
   */
  start(): Promise<void>;
  
  /**
   * Check if the handler has received all expected data
   * @returns true if all expected data has been received and matches
   */
  isComplete(): boolean;
  
  /**
   * Get statistics about received vs expected data
   * @returns Object with totalExpected, totalReceived, and isComplete
   */
  getStats(): {
    totalExpected: number;
    totalReceived: number;
    isComplete: boolean;
  };
  
  /**
   * Clean up any resources (unsubscribe, close connections, etc.)
   */
  dispose(): void;
}