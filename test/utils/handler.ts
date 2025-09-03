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
   * @param graphqlClient The Apollo GraphQL client to use for operations
   * @returns Promise that resolves when the stream is established
   */
  start(graphqlClient: ApolloClient): Promise<void>;
  
  /**
   * Clean up any resources (unsubscribe, close connections, etc.)
   */
  dispose(): void;
}