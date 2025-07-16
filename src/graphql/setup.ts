import { createYoga } from 'graphql-yoga';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import type { GraphQLSchema } from 'graphql';
import { logger } from '../core/logger.js';
import type { DatabaseStreamer } from '../database/types.js';

export interface ServerContext {
  viewName: string;
  stream: DatabaseStreamer;
  primaryKeyField: string;
}

export interface GraphQLServers {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

export function createGraphQLServers(
  schema: GraphQLSchema,
  context: ServerContext,
  options: { graphiqlEnabled: boolean }
): GraphQLServers {
  const yoga = createYogaServer(schema, context, options);
  const httpServer = createServer(yoga);
  const wsServer = setupWebSocketServer(httpServer, schema, context, yoga.graphqlEndpoint);
  
  return { 
    start: async (port: number) => {
      await startHttpServer(httpServer, port);
    },
    stop: async () => {
      wsServer.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    }
  };
}

function createYogaServer(schema: GraphQLSchema, context: ServerContext, options: { graphiqlEnabled: boolean }) {
  const log = logger.child({ component: 'graphql-yoga' });
  
  return createYoga({
    schema,
    graphiql: options.graphiqlEnabled ? {
      subscriptionsProtocol: 'WS',
    } : false,
    context: () => context,
    maskedErrors: false,
    plugins: [
      {
        onRequest: ({ request, url }) => {
          log.debug('GraphQL HTTP Request', {
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
          
          log.info({
            operationName,
            operationType,
            hasVariables
          }, 'GraphQL Operation');
        },
        onResultProcess: ({ result, request }: any) => {
          if (result.data) {
            log.debug('GraphQL Result', {
              operationType: request.operationName || 'unnamed',
              dataKeys: Object.keys(result.data),
              resultSample: JSON.stringify(result.data).substring(0, 200) + '...'
            });
          }
        }
      }
    ],
  });
}

function setupWebSocketServer(
  httpServer: ReturnType<typeof createServer>,
  schema: GraphQLSchema,
  context: ServerContext,
  graphqlEndpoint: string
): WebSocketServer {
  const log = logger.child({ component: 'websocket' });
  
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: graphqlEndpoint,
  });

  useServer(
    {
      schema,
      context: () => context,
      onConnect: (ctx) => {
        log.debug('GraphQL WebSocket client connected', { 
          connectionParams: ctx.connectionParams 
        });
      },
      onSubscribe: (ctx, msg) => {
        const operationName = msg.payload.operationName || 'Anonymous';
        const hasVariables = Object.keys(msg.payload.variables || {}).length > 0;
        
        log.info({
          operationName,
          operationType: 'subscription',
          hasVariables,
          viewName: context.viewName
        }, 'GraphQL Operation');
      },
      onDisconnect: (ctx) => {
        log.debug('GraphQL WebSocket client disconnected');
      },
      onError: (ctx, message, errors) => {
        log.debug('GraphQL WebSocket error', { 
          message: message?.payload,
          errorCount: errors.length 
        });
      },
    },
    wsServer
  );
  
  return wsServer;
}

async function startHttpServer(httpServer: ReturnType<typeof createServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    httpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Please ensure no other process is using this port or change GRAPHQL_PORT in your .env file.`));
      } else {
        reject(err);
      }
    });
    httpServer.listen(port, () => {
      resolve();
    });
  });
}

