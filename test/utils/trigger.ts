import { ApolloClient, gql } from '@apollo/client';
import { EventStreamHandler, HandlerCallbacks, Stats } from './handler';
import { StateTracker, State } from './tracker';
import { WebhookEndpoint } from './webhook';

export interface TriggerConfig<TData = any> {
  id: string; // The trigger ID
  clientId: string;
  query: string; // GraphQL mutation to create trigger
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
      onCompleted: () => {
        console.log(`Trigger ${config.id} for client ${config.clientId} completed`);
        config.callbacks.onCompleted(config.id);
      },
      onFailed: () => {
        // The error is already logged when we detect it
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
  
  dispose(): void {
    this.stateTracker.dispose();
    // Unregister the webhook endpoint
    if (this.webhookPath) {
      this.config.webhookEndpoint.unregister(this.webhookPath);
      console.log(`Unregistered webhook: ${this.webhookPath}`);
    }
  }
}