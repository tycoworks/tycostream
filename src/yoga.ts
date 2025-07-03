import { createYoga } from 'graphql-yoga';
import { isGraphQLUIEnabled } from './config.js';
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
        graphiql: isGraphQLUIEnabled() ? {
          subscriptionsProtocol: 'WS',
        } : false,
        context: () => ({
          pubsub: this.eventBus,
          viewName: this.viewName,
          viewCache: this.viewCache,
          primaryKeyField: this.schema!.primaryKeyField,
        }),
        maskedErrors: false,
        plugins: [
          {
            onRequest: ({ request, url }) => {
              this.log.debug('GraphQL HTTP Request', {
                method: request.method,
                url: url.pathname,
                userAgent: request.headers.get('user-agent')?.substring(0, 50) || 'unknown'
              });
            },
            onParse: ({ params }: any) => {
              const query = String(params?.source || '');
              const queryText = query.replace(/\s+/g, ' ').trim();
              
              // Extract operation type (query, mutation, subscription)
              const operationMatch = queryText.match(/^(query|mutation|subscription)\s/i);
              const operationType = operationMatch ? operationMatch[1]?.toLowerCase() : 
                                  queryText.startsWith('{') ? 'query' : 'unknown';
                
              const hasVariables = params?.variables ? Object.keys(params.variables).length > 0 : false;
              this.log.info('GraphQL Operation', {
                operationName: params?.operationName || 'unnamed',
                operation: operationType,
                hasVariables
              });
            },
            onResultProcess: ({ result, request }: any) => {
              if (result.data) {
                this.log.debug('GraphQL Result', {
                  operationType: request.operationName || 'unnamed',
                  dataKeys: Object.keys(result.data),
                  resultSample: JSON.stringify(result.data).substring(0, 200) + '...'
                });
              }
            }
          }
        ],
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
            this.log.debug('GraphQL WebSocket client connected', { 
              connectionParams: ctx.connectionParams 
            });
            this.eventBus.publish(EVENTS.CLIENT_SUBSCRIBED, { viewName: this.viewName });
          },
          onDisconnect: (ctx) => {
            this.log.debug('GraphQL WebSocket client disconnected');
            this.eventBus.publish(EVENTS.CLIENT_UNSUBSCRIBED, { viewName: this.viewName });
          },
          onError: (ctx, message, errors) => {
            this.log.debug('GraphQL WebSocket error', { 
              message: message?.payload,
              errorCount: errors.length 
            });
          },
        },
        this.wsServer
      );

      await new Promise<void>((resolve, reject) => {
        this.server!.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${this.port} is already in use. Please ensure no other process is using this port or change GRAPHQL_PORT in your .env file.`));
          } else {
            reject(err);
          }
        });
        this.server!.listen(this.port, () => {
          resolve();
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
        const log = logger.child({ component: 'subscription' });
        
        // Send initial snapshot first
        const snapshot = viewCache.getSnapshot();
        log.debug('Subscription initial snapshot', {
          viewName,
          snapshotSize: snapshot.length,
          sampleRow: snapshot[0] ? JSON.stringify(snapshot[0]).substring(0, 100) : 'none'
        });
        
        for (const row of snapshot) {
          const payload = { [viewName]: row };
          log.debug('Subscription yielding snapshot event', {
            viewName,
            rowSample: JSON.stringify(row).substring(0, 100),
            symbol: row.symbol
          });
          yield payload;
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

    // Create query resolver for current snapshot
    const queryResolvers: Record<string, any> = {};
    const queryFieldName = this.mapFieldToView(this.viewName);
    queryResolvers[queryFieldName] = (parent: any, args: any, context: any) => {
      const { viewCache } = context;
      return viewCache.getSnapshot();
    };

    const resolvers = {
      Query: queryResolvers,
      Subscription: subscriptionResolvers,
    };

    const executableSchema = buildSchema(this.schema.typeDefs);
    
    // Attach resolvers to schema
    const schemaWithResolvers = {
      ...executableSchema,
      _subscriptionType: executableSchema.getSubscriptionType(),
    };

    // Manual resolver attachment for queries
    if (executableSchema.getQueryType()) {
      const queryFields = executableSchema.getQueryType()!.getFields();
      for (const [fieldName, field] of Object.entries(queryFields)) {
        if (resolvers.Query[fieldName]) {
          (field as any).resolve = resolvers.Query[fieldName];
        }
      }
    }

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