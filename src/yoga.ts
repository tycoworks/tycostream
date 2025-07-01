import { createYoga } from 'graphql-yoga';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { buildSchema } from 'graphql';
import type { LoadedSchema, StreamEvent } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { ViewCache } from '../shared/viewCache.js';
import { pubsub, type PubSub } from './pubsub.js';
import { EVENTS } from '../shared/events.js';

export class GraphQLServer {
  private log = logger.child({ component: 'graphql' });
  private server: ReturnType<typeof createServer> | null = null;
  private wsServer: WebSocketServer | null = null;
  private schema: LoadedSchema | null = null;

  constructor(
    private loadedSchema: LoadedSchema,
    private viewName: string,
    private viewCache: ViewCache,
    private port: number = 4000,
    private eventBus: PubSub = pubsub
  ) {
    this.schema = loadedSchema;
  }

  /**
   * Map GraphQL subscription field to view name per ARCHITECTURE.md:82
   * In 1.1: direct mapping by convention
   * In 1.3: will use explicit metadata configuration
   */
  private mapFieldToView(fieldName: string): string {
    // For Milestone 1.1: direct 1:1 mapping
    return fieldName;
  }

  async start(): Promise<void> {
    try {
      this.log.info('Starting GraphQL server', { port: this.port, viewName: this.viewName });

      const schema = this.buildGraphQLSchema();
      
      const yoga = createYoga({
        schema,
        graphiql: {
          subscriptionsProtocol: 'WS',
        },
        context: () => ({
          pubsub: this.eventBus,
          viewName: this.viewName,
          viewCache: this.viewCache,
          primaryKeyField: this.schema!.primaryKeyField,
        }),
      });

      this.server = createServer(yoga);
      
      // Setup WebSocket server for subscriptions
      this.wsServer = new WebSocketServer({
        server: this.server,
        path: yoga.graphqlEndpoint,
      });

      const serverCleanup = useServer(
        {
          schema,
          context: () => ({
            pubsub: this.eventBus,
            viewName: this.viewName,
            viewCache: this.viewCache,
            primaryKeyField: this.schema!.primaryKeyField,
          }),
          onConnect: (ctx) => {
            this.log.info('GraphQL WebSocket client connected', { 
              connectionParams: ctx.connectionParams 
            });
            this.eventBus.publish(EVENTS.CLIENT_SUBSCRIBED, { viewName: this.viewName });
          },
          onDisconnect: (ctx) => {
            this.log.info('GraphQL WebSocket client disconnected');
            this.eventBus.publish(EVENTS.CLIENT_UNSUBSCRIBED, { viewName: this.viewName });
          },
        },
        this.wsServer
      );

      await new Promise<void>((resolve, reject) => {
        this.server!.listen(this.port, (err?: Error) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });

      this.log.info('GraphQL server started', { 
        port: this.port,
        endpoint: `http://localhost:${this.port}/graphql`,
        subscriptions: `ws://localhost:${this.port}/graphql`
      });

    } catch (error) {
      this.log.error('Failed to start GraphQL server', {}, error as Error);
      throw new Error(`GraphQL server startup failed: ${(error as Error).message}`);
    }
  }

  async stop(): Promise<void> {
    this.log.info('Stopping GraphQL server');
    
    if (this.wsServer) {
      this.wsServer.close();
      this.wsServer = null;
    }
    
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
    
    this.log.info('GraphQL server stopped');
  }

  private buildGraphQLSchema() {
    if (!this.schema) {
      throw new Error('Schema not loaded');
    }

    // Build resolvers dynamically based on schema
    const subscriptionResolvers: Record<string, any> = {};
    
    // Create subscription resolver for the view
    // Per ARCHITECTURE.md:82 - field names map to view names by convention
    const subscriptionFieldName = this.mapFieldToView(this.viewName);
    subscriptionResolvers[subscriptionFieldName] = {
      subscribe: async function* (parent: any, args: any, context: any) {
        const { viewCache, viewName } = context;
        
        // Send initial snapshot first
        const snapshot = viewCache.getSnapshot();
        for (const row of snapshot) {
          yield { [viewName]: row };
        }

        // Create event queue for live updates
        const eventQueue: StreamEvent[] = [];
        let isActive = true;
        
        // Single subscription that queues events
        const unsubscribe = pubsub.subscribeToStream(viewName, (streamEvent: StreamEvent) => {
          if (isActive) {
            eventQueue.push(streamEvent);
          }
        });

        try {
          // Process queued events as they arrive
          while (isActive) {
            // Wait for events to arrive
            while (eventQueue.length === 0 && isActive) {
              await new Promise(resolve => setTimeout(resolve, 10)); // Small delay to prevent busy waiting
            }
            
            // Process all queued events
            while (eventQueue.length > 0 && isActive) {
              const streamEvent = eventQueue.shift()!;
              
              if (streamEvent.diff === 1) {
                yield { [viewName]: streamEvent.row };
              }
              // Skip deletes for now
            }
          }
        } finally {
          isActive = false;
          unsubscribe();
        }
      },
      resolve: (payload: any) => payload[this.viewName],
    };

    const resolvers = {
      Subscription: subscriptionResolvers,
    };

    const executableSchema = buildSchema(this.schema.typeDefs);
    
    // Attach resolvers to schema
    const schemaWithResolvers = {
      ...executableSchema,
      _subscriptionType: executableSchema.getSubscriptionType(),
    };

    // Manual resolver attachment for subscriptions
    if (executableSchema.getSubscriptionType()) {
      const subscriptionFields = executableSchema.getSubscriptionType()!.getFields();
      for (const [fieldName, field] of Object.entries(subscriptionFields)) {
        if (resolvers.Subscription[fieldName]) {
          (field as any).subscribe = resolvers.Subscription[fieldName].subscribe;
          (field as any).resolve = resolvers.Subscription[fieldName].resolve;
        }
      }
    }

    return executableSchema;
  }
}