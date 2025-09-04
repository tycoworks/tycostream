import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks, Stats } from './handler';
import { StateTracker, State } from './tracker';
import { WebhookEndpoint } from './webhook';

export interface TriggerConfig<TData = any> {
  id: string; // The trigger ID
  clientId: string;
  query: string; // GraphQL mutation to create trigger
  deleteQuery?: string; // Optional GraphQL mutation to delete trigger
  idField: string; // Primary key field for state tracking
  expectedEvents: TData[]; // Expected webhook payloads in order
  webhookEndpoint: WebhookEndpoint;
  graphqlClient: ApolloClient;
  callbacks: HandlerCallbacks;
  livenessTimeoutMs: number;
}

/**
 * Handles GraphQL triggers with webhook callbacks
 * Creates a trigger via mutation and processes webhook events
 */
export class TriggerHandler<TData = any> implements EventStreamHandler {
  private triggerName: string;
  private triggerData?: any; // Store the response from create mutation
  private receivedEvents: TData[] = [];
  private expectedEvents: TData[];
  private startPromise?: Promise<void>;
  private stateTracker: StateTracker;
  private webhookPath?: string; // Store the webhook path for unregistration
  
  constructor(private config: TriggerConfig<TData>) {
    // Generate unique trigger name
    this.triggerName = `trigger_${config.clientId}_${Date.now()}`;
    this.expectedEvents = config.expectedEvents;
    
    // Initialize state tracker with callbacks that include our ID
    this.stateTracker = new StateTracker({
      livenessTimeoutMs: config.livenessTimeoutMs,
      onStalled: () => {
        console.log(`Trigger ${config.id} for client ${config.clientId} stalled`);
        config.callbacks.onStalled(config.id);
      },
      onRecovered: () => {
        console.log(`Trigger ${config.id} for client ${config.clientId} recovered`);
        config.callbacks.onRecovered(config.id);
      },
      onCompleted: async () => {
        console.log(`Trigger ${config.id} for client ${config.clientId} completed`);
        await this.cleanupTrigger();
        config.callbacks.onCompleted(config.id);
      },
      onFailed: async () => {
        // The error is already logged when we detect it
        await this.cleanupTrigger();
        config.callbacks.onFailed(config.id, new Error(`Trigger ${config.id} failed`));
      }
    });
  }
  
  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.doStart();
    }
    return this.startPromise;
  }
  
  private async doStart(): Promise<void> {
    // Step 1: Register webhook endpoint with our callback handler
    this.webhookPath = `/webhook/${this.config.clientId}/${this.triggerName}`;
    const webhookUrl = this.config.webhookEndpoint.register(this.webhookPath, async (payload) => {
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
        console.error(
          `Client ${this.config.clientId}: Trigger mutation error: ${errorMessage}`
        );
        this.stateTracker.markFailed();
        return;
      }
      
      // Store the trigger data from the response (contains trigger name, ID, etc.)
      this.triggerData = result.data;
      
      console.log(`Client ${this.config.clientId}: Trigger created successfully with webhook URL: ${webhookUrl}`);
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      console.error(
        `Client ${this.config.clientId}: Failed to create trigger: ${errorMessage}`
      );
      this.stateTracker.markFailed();
    }
  }
  
  private processEvent(payload: any): void {
    // Record activity for liveness tracking
    this.stateTracker.recordActivity();
    
    // Remove timestamp from payload for comparison (it varies)
    // In future, also remove eventId when tycostream provides it
    const { timestamp, ...comparablePayload } = payload;
    
    // Add event to received list
    this.receivedEvents.push(comparablePayload as TData);
    
    // Check if we're finished after state update
    this.checkCompletion();
  }
  
  private checkCompletion(): void {
    if (this.isComplete()) {
      this.stateTracker.markCompleted();
    }
  }
  
  private isComplete(): boolean {
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
  
  getState(): State {
    return this.stateTracker.getState();
  }
  
  getStats(): Stats {
    return {
      totalExpected: this.expectedEvents.length,
      totalReceived: this.receivedEvents.length
    };
  }
  
  private async cleanupTrigger(): Promise<void> {
    // Delete the trigger via GraphQL mutation if deleteQuery is provided
    if (this.config.deleteQuery && this.triggerData) {
      try {
        console.log(`Deleting trigger for ${this.config.id}`);
        
        // Extract the first mutation result from the data
        // The structure is: { mutationName: { ...fields } }
        const mutationResult = Object.values(this.triggerData)[0] as any;
        
        // Pass the mutation result as variables for the delete query
        await this.config.graphqlClient.mutate({
          mutation: gql`${this.config.deleteQuery}`,
          variables: mutationResult
        });
        
        console.log(`Deleted trigger for ${this.config.id}`);
        // Clear trigger data to prevent duplicate deletion
        this.triggerData = undefined;
      } catch (error: any) {
        console.error(`Failed to delete trigger for ${this.config.id}: ${error.message}`);
      }
    }
    
    // Unregister the webhook endpoint
    if (this.webhookPath) {
      console.log(`Unregistering webhook for trigger ${this.config.id}: ${this.webhookPath}`);
      this.config.webhookEndpoint.unregister(this.webhookPath);
      this.webhookPath = undefined;
    }
  }
  
  async dispose(): Promise<void> {
    this.stateTracker.dispose();
    await this.cleanupTrigger();
  }
}