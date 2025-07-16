import { createYoga } from 'graphql-yoga';
import { createServer } from 'http';
import { useServer } from 'graphql-ws/lib/use/ws';
import { WebSocketServer } from 'ws';
import type { GraphQLSchema } from 'graphql';
import { isGraphQLUIEnabled } from './config.js';
import { logger } from '../shared/logger.js';

export interface ServerContext {
  viewName: string;
  stream: any;
  primaryKeyField: string;
}

export interface ServerSetupResult {
  httpServer: ReturnType<typeof createServer>;
  wsServer: WebSocketServer;
}

/**
 * Sets up HTTP and WebSocket servers for GraphQL
 */
export async function setupGraphQLServers(
  schema: GraphQLSchema,
  context: ServerContext,
  port: number
): Promise<ServerSetupResult> {
  const log = logger.child({ component: 'server-setup' });

  const yoga = createYoga({
    schema,
    graphiql: isGraphQLUIEnabled() ? {
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

  const httpServer = createServer(yoga);
  
  // Setup WebSocket server for subscriptions
  const wsServer = new WebSocketServer({
    server: httpServer,
    path: yoga.graphqlEndpoint,
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

  // Start the HTTP server
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

  return { httpServer, wsServer };
}