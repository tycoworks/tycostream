import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks } from './handler';
import { StateTracker } from './tracker';

export interface WebhookTriggerConfig<TData = any> {
  clientId: string;
  query: string; // GraphQL mutation to create trigger
  idField: string; // Primary key field for state tracking
  expectedEvents: TData[]; // Expected webhook payloads in order
  createWebhook: (endpoint: string, handler: (payload: any) => Promise<void>) => string;
  callbacks: HandlerCallbacks;
}

/**
 * Handles GraphQL triggers with webhook callbacks
 * Creates a trigger via mutation and processes webhook events
 */
export class TriggerHandler<TData = any> implements EventStreamHandler {
  private triggerName: string;
  private tracker: StateTracker<TData>;
  
  constructor(private config: WebhookTriggerConfig<TData>) {
    // Generate unique trigger name
    this.triggerName = `trigger_${config.clientId}_${Date.now()}`;
    
    // Convert array to Map for StateTracker, with order tracking
    const expectedStateMap = new Map<string | number, TData>();
    const expectedOrder: Array<string | number> = [];
    
    config.expectedEvents.forEach((event: any, index) => {
      const id = event[config.idField] || index;
      expectedStateMap.set(id, event);
      expectedOrder.push(id);
    });
    
    // Create tracker with both expected state and expected order
    this.tracker = new StateTracker<TData>(expectedStateMap, expectedOrder);
  }
  
  async start(graphqlClient: ApolloClient): Promise<void> {
    // Step 1: Register webhook endpoint with our callback handler
    const endpoint = `/webhook/${this.config.clientId}/${this.triggerName}`;
    const webhookUrl = this.config.createWebhook(endpoint, async (payload) => {
      console.log(`Client ${this.config.clientId} received webhook for trigger ${this.triggerName}`);
      this.processEvent(payload);
    });
    
    console.log(`Registered webhook endpoint: ${webhookUrl}`);
    
    // Step 2: Execute the GraphQL mutation to create the trigger
    try {
      const result = await graphqlClient.mutate({
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
    
    // Extract ID using configured idField
    // Try various locations where the ID might be
    const id = payload.data?.[this.config.idField] || 
               payload[this.config.idField] || 
               payload.trigger_name || 
               Date.now();
    
    // For webhooks, we typically get the full payload as the data
    // The payload might already be the data, or it might be wrapped
    const data = payload.data || payload;
    
    // Insert directly into the tracker (webhooks typically represent new events)
    this.tracker.insert(id, data);
    
    // Last: check if we're finished (after state has been updated)
    this.config.callbacks.onCheckFinished();
  }
  
  isComplete(): boolean {
    return this.tracker.isComplete();
  }
  
  getStats() {
    return this.tracker.getStats();
  }
  
  dispose(): void {
    // Webhook handlers are cleaned up by the webhook server
    // Nothing specific to dispose here
  }
}