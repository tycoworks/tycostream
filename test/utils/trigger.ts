import { ApolloClient, gql } from '@apollo/client';
import { EventStream, EventProcessor, GenericEventHandler, GenericHandlerConfig, HandlerCallbacks, Stats } from './events';
import { State } from './tracker';
import { WebhookEndpoint } from './webhook';

/**
 * Webhook-based trigger event stream
 * Sets up webhook endpoint and creates trigger via GraphQL mutation
 */
class TriggerStream implements EventStream<any> {
  private webhookPath?: string;
  private triggerData?: any;
  private webhookCallback?: (payload: any) => Promise<void>;
  private triggerName: string;
  
  constructor(
    private clientId: string,
    private webhookEndpoint: WebhookEndpoint,
    private graphqlClient: ApolloClient,
    private createQuery: string,
    private deleteQuery: string,  // Required for proper cleanup
    private id: string  // Required ID for logging
  ) {
    // Generate unique trigger name
    this.triggerName = `trigger_${clientId}_${Date.now()}`;
  }
  
  async subscribe(
    onData: (data: any) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    try {
      // Step 1: Register webhook endpoint with our callback handler
      this.webhookPath = `/webhook/${this.clientId}/${this.triggerName}`;
      
      // Store the callback for later unregistration
      this.webhookCallback = async (payload) => {
        console.log(`Client ${this.clientId} received webhook for trigger ${this.triggerName}`);
        onData(payload);
      };
      
      const webhookUrl = this.webhookEndpoint.register(this.webhookPath, this.webhookCallback);
      console.log(`Registered webhook endpoint: ${webhookUrl}`);
      
      // Step 2: Execute the GraphQL mutation to create the trigger
      const result = await this.graphqlClient.mutate({
        mutation: gql`${this.createQuery}`,
        variables: { webhookUrl }
      });
      
      if (result.error) {
        const errorMessage = result.error?.message || 'Unknown GraphQL error';
        console.error(
          `Client ${this.clientId}: Trigger mutation error: ${errorMessage}`
        );
        if (onError) {
          onError(new Error(errorMessage));
        }
        return;
      }
      
      // Store the trigger data from the response (contains trigger name, ID, etc.)
      this.triggerData = result.data;
      
      console.log(`Client ${this.clientId}: Trigger created successfully with webhook URL: ${webhookUrl}`);
    } catch (error: any) {
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      console.error(
        `Client ${this.clientId}: Failed to create trigger: ${errorMessage}`
      );
      if (onError) {
        onError(error instanceof Error ? error : new Error(errorMessage));
      }
    }
  }
  
  async unsubscribe(): Promise<void> {
    // Delete the trigger via GraphQL mutation
    if (this.triggerData) {
      try {
        console.log(`Deleting trigger for ${this.id}`);
        
        // Extract the first mutation result from the data
        // The structure is: { mutationName: { ...fields } }
        const mutationResult = Object.values(this.triggerData)[0] as any;
        
        // Pass the mutation result as variables for the delete query
        await this.graphqlClient.mutate({
          mutation: gql`${this.deleteQuery}`,
          variables: mutationResult
        });
        
        console.log(`Deleted trigger for ${this.id}`);
        this.triggerData = undefined;
      } catch (error: any) {
        console.error(`Failed to delete trigger for ${this.id}: ${error.message}`);
      }
    }
    
    // Unregister the webhook endpoint
    if (this.webhookPath) {
      console.log(`Unregistering webhook for trigger ${this.id}: ${this.webhookPath}`);
      this.webhookEndpoint.unregister(this.webhookPath);
      this.webhookPath = undefined;
      this.webhookCallback = undefined;
    }
  }
}

/**
 * Processes trigger events by collecting them in order
 * Handles webhook payload comparison (excluding timestamp)
 */
class TriggerProcessor<TData = any> implements EventProcessor<TData> {
  private receivedEvents: TData[] = [];
  
  constructor(
    private expectedEvents: TData[]
  ) {}
  
  processEvent(data: any): void {
    // Remove timestamp from payload for comparison (it varies)
    // In future, also remove eventId when tycostream provides it
    const { timestamp, ...comparablePayload } = data;
    
    // Add event to received list
    this.receivedEvents.push(comparablePayload as TData);
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
  
  getStats(): Stats {
    return {
      totalExpected: this.expectedEvents.length,
      totalReceived: this.receivedEvents.length
    };
  }
}

export interface TriggerConfig<TData = any> {
  id: string; // The trigger ID
  clientId: string;
  query: string; // GraphQL mutation to create trigger
  deleteQuery: string; // GraphQL mutation to delete trigger (required for cleanup)
  idField: string; // Primary key field for state tracking
  expectedEvents: TData[]; // Expected webhook payloads in order
  webhookEndpoint: WebhookEndpoint;
  graphqlClient: ApolloClient;
  callbacks: HandlerCallbacks;
  livenessTimeoutMs: number;
}

/**
 * Creates a GraphQL trigger handler
 * Sets up the appropriate stream and processor, then returns a GenericEventHandler
 */
export function createTriggerHandler<TData = any>(
  config: TriggerConfig<TData>
): GenericEventHandler<TData> {
  // Create the processor
  const processor = new TriggerProcessor<TData>(config.expectedEvents);
  
  // Create the stream (trigger name is generated internally)
  const stream = new TriggerStream(
    config.clientId,
    config.webhookEndpoint,
    config.graphqlClient,
    config.query,
    config.deleteQuery,
    config.id
  );
  
  // Create the generic handler config
  const handlerConfig: GenericHandlerConfig = {
    id: config.id,
    clientId: config.clientId,
    callbacks: config.callbacks,
    livenessTimeoutMs: config.livenessTimeoutMs
  };
  
  // Create and return the generic handler with stream and processor
  return new GenericEventHandler<TData>(stream, processor, handlerConfig);
}