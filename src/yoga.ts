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

        // Then subscribe to live updates
        let isActive = true;
        const unsubscribe = pubsub.subscribeToStream(viewName, (streamEvent: StreamEvent) => {
          // This callback doesn't need to return anything - 
          // we handle the events in the main loop below
        });

        try {
          // Keep subscription alive and yield stream events
          while (isActive) {
            const streamEvent: StreamEvent = await new Promise((resolve) => {
              const handler = (event: StreamEvent) => {
                resolve(event);
              };
              const unsub = pubsub.subscribeToStream(viewName, handler);
              
              // Clean up after getting one event
              setTimeout(() => unsub(), 100);
            });

            if (streamEvent.diff === 1) {
              yield { [viewName]: streamEvent.row };
            }
            // Skip deletes for now
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