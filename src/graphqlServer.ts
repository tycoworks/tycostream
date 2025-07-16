import { createYoga } from 'graphql-yoga';
import { isGraphQLUIEnabled } from './config.js';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import { buildSchema } from 'graphql';
import type { LoadedSchema } from '../shared/schema.js';
import { logger } from '../shared/logger.js';
import { GraphQLSubscriptionHandler } from './graphqlSubscriptionHandler.js';
import type { DatabaseStreamer } from '../shared/databaseStreamer.js';

// Component-specific configuration
const DEFAULT_GRAPHQL_PORT = 4000;

export class GraphQLServer {
  private log = logger.child({ component: 'graphql' });
  private server: ReturnType<typeof createServer> | null = null;
  private wsServer: WebSocketServer | null = null;
  private schema: LoadedSchema | null = null;

  constructor(
    private loadedSchema: LoadedSchema,
    private viewName: string,
    private stream: DatabaseStreamer,
    private port: number = DEFAULT_GRAPHQL_PORT
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
          viewName: this.viewName,
          stream: this.stream,
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
            onExecute: ({ args }: any) => {
              const operationName = args.operationName || 'Anonymous';
              const operation = args.document.definitions.find((def: any) => 
                def.kind === 'OperationDefinition'
              );
              const operationType = operation?.operation || 'unknown';
              const hasVariables = Object.keys(args.variableValues || {}).length > 0;
              
              this.log.info({
                operationName,
                operationType,
                hasVariables
              }, 'GraphQL Operation');
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
            viewName: this.viewName,
            stream: this.stream,
            primaryKeyField: this.schema!.primaryKeyField,
          }),
          onConnect: (ctx) => {
            this.log.debug('GraphQL WebSocket client connected', { 
              connectionParams: ctx.connectionParams 
            });
            // Client connected
          },
          onSubscribe: (ctx, msg) => {
            const operationName = msg.payload.operationName || 'Anonymous';
            const hasVariables = Object.keys(msg.payload.variables || {}).length > 0;
            
            this.log.info({
              operationName,
              operationType: 'subscription',
              hasVariables,
              viewName: this.viewName
            }, 'GraphQL Operation');
          },
          onDisconnect: (ctx) => {
            this.log.debug('GraphQL WebSocket client disconnected');
            // Client disconnected
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
    // Field names map to view names by convention
    const subscriptionFieldName = this.mapFieldToView(this.viewName);
    subscriptionResolvers[subscriptionFieldName] = {
      subscribe: async function* (parent: any, args: any, context: any) {
        const { stream, viewName } = context;
        const log = logger.child({ component: 'subscription' });
        
        log.debug('Creating new GraphQL subscription handler', { viewName });
        
        // Create a new GraphQLSubscriptionHandler for this subscription
        const streamHandler = new GraphQLSubscriptionHandler(viewName);
        
        // Subscribe the handler to the stream
        const unsubscribe = stream.subscribe(streamHandler);
        
        try {
          // Delegate to the ClientStreamHandler
          const iterator = streamHandler.createAsyncIterator();
          let result = await iterator.next();
          
          while (!result.done) {
            yield result.value;
            result = await iterator.next();
          }
        } finally {
          log.debug('Subscription ended, cleaning up handler', { 
            viewName, 
            handlerId: streamHandler.id 
          });
          
          // Unsubscribe from the stream
          unsubscribe();
          
          // Close the handler
          streamHandler.close();
        }
      },
      resolve: (payload: any) => payload[this.viewName],
    };

    // Create query resolver for current snapshot
    const queryResolvers: Record<string, any> = {};
    const queryFieldName = this.mapFieldToView(this.viewName);
    queryResolvers[queryFieldName] = (parent: any, args: any, context: any) => {
      const { stream } = context;
      return stream.getAllRows();
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