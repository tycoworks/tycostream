import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks } from './handler';

export interface TriggerConfig<TData = any> {
  clientId: string;
  query: string; // GraphQL mutation to create trigger
  idField: string; // Primary key field for state tracking
  expectedEvents: TData[]; // Expected webhook payloads in order
  createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
  graphqlClient: ApolloClient;
  callbacks: HandlerCallbacks;
}

/**
 * Handles GraphQL triggers with webhook callbacks
 * Creates a trigger via mutation and processes webhook events
 */
export class TriggerHandler<TData = any> implements EventStreamHandler {
  private triggerName: string;
  private receivedEvents: TData[] = [];
  private expectedEvents: TData[];
  private startPromise?: Promise<void>;
  
  constructor(private config: TriggerConfig<TData>) {
    // Generate unique trigger name
    this.triggerName = `trigger_${config.clientId}_${Date.now()}`;
    this.expectedEvents = config.expectedEvents;
  }
  
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    return this.startPromise;
  }
  
  private async doStart(): Promise<void> {
    // Step 1: Register webhook endpoint with our callback handler
    const endpoint = `/webhook/${this.config.clientId}/${this.triggerName}`;
    const webhookUrl = this.config.createWebhook(endpoint, async (payload) => {
      console.log(`Client ${this.config.clientId} received webhook for trigger ${this.triggerName}`);
      this.processEvent(payload);
    });
    
    console.log(`Registered webhook endpoint: ${webhookUrl}`);
    
    // Step 2: Execute the GraphQL mutation to create the trigger
    try {
      const result = await this.config.graphqlClient.mutate({
        mutation: gql`${this.config.query}`,
        variables: { webhookUrl }
      });
      
      if (result.error) {
        const errorMessage = result.error?.message || 'Unknown GraphQL error';
        const contextError = new Error(
          `Client ${this.config.clientId}: Trigger mutation error: ${errorMessage}`
        );
        this.config.callbacks.onError(contextError);
        return;
      }
      
      console.log(`Client ${this.config.clientId}: Trigger created successfully with webhook URL: ${webhookUrl}`);
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      const contextError = new Error(
        `Client ${this.config.clientId}: Failed to create trigger: ${errorMessage}`
      );
      this.config.callbacks.onError(contextError);
    }
  }
  
  private processEvent(payload: any): void {
    // First: notify that data was received (for liveness tracking)
    this.config.callbacks.onDataReceived();
    
    // Remove timestamp from payload for comparison (it varies)
    // In future, also remove eventId when tycostream provides it
    const { timestamp, ...comparablePayload } = payload;
    
    // Add event to received list
    this.receivedEvents.push(comparablePayload as TData);
    
    // Last: check if we're finished (after state has been updated)
    this.config.callbacks.onCheckFinished();
  }
  
  isComplete(): boolean {
    if (this.receivedEvents.length === this.expectedEvents.length) {
      // Compare each event in sequence
      for (let i = 0; i < this.expectedEvents.length; i++) {
        if (JSON.stringify(this.receivedEvents[i]) !== JSON.stringify(this.expectedEvents[i])) {
          return false;
        }
      }
      return true;
    }
    return false;
  }
  
  getStats() {
    return {
      totalExpected: this.expectedEvents.length,
      totalReceived: this.receivedEvents.length,
      isComplete: this.isComplete()
    };
  }
  
  dispose(): void {
    // Webhook handlers are cleaned up by the webhook server
    // Nothing specific to dispose here
  }
}