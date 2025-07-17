import { makeExecutableSchema } from '@graphql-tools/schema';
import type { LoadedSchema } from '../core/schema.js';
import { logger, truncateForLog } from '../core/logger.js';
import type { DatabaseConfig } from '../core/config.js';
import { isGraphQLUIEnabled } from '../core/config.js';
import { createGraphQLServers, type GraphQLServers } from './setup.js';
import { StreamerManager } from '../database/streamerManager.js';

// Component-specific configuration
const DEFAULT_GRAPHQL_PORT = 4000;

// GraphQL subscription resolver type
type SubscriptionResolver = {
  subscribe: (parent: any, args: any, context: any) => AsyncIterator<any>;
  resolve?: (payload: any) => any;
};

export class GraphQLServer {
  private log = logger.child({ component: 'graphql' });
  private servers: GraphQLServers | null = null;
  private streamerManager: StreamerManager | null = null;

  constructor(
    private dbConfig: DatabaseConfig,
    private schema: LoadedSchema,
    private port: number = DEFAULT_GRAPHQL_PORT
  ) {}

  async start(): Promise<void> {
    try {
      this.log.info('Starting GraphQL server', { port: this.port, viewCount: this.schema.views.size });

      // Create and start streamer manager
      this.streamerManager = new StreamerManager(this.dbConfig, this.schema);
      await this.streamerManager.start();
      
      this.log.debug('All database streamers created and started');

      const schema = this.buildGraphQLSchema();
      
      // Create HTTP and WebSocket servers
      this.servers = createGraphQLServers(
        schema,
        this.streamerManager,
        {
          graphiqlEnabled: isGraphQLUIEnabled()
        }
      );
      
      // Start servers
      await this.servers.start(this.port);

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
    if (this.servers) {
      await this.servers.stop();
      this.servers = null;
    }
    
    if (this.streamerManager) {
      await this.streamerManager.stop();
      this.streamerManager = null;
    }
    
    this.log.info('GraphQL server stopped');
  }

  private buildGraphQLSchema() {
    const resolvers = {
      Query: {
        _empty: () => null
      },
      Subscription: {} as Record<string, SubscriptionResolver>,
    };

    // Create resolvers for each view (subscriptions only)
    for (const [viewName, viewSchema] of this.schema.views) {
      resolvers.Subscription[viewName] = this.createViewSubscriptionResolver(viewName);
    }

    return makeExecutableSchema({
      typeDefs: this.schema.typeDefs,
      resolvers
    });
  }

  private createViewSubscriptionResolver(viewName: string) {
    return {
      subscribe: async function* (_parent: unknown, _args: unknown, context: { streamerManager: StreamerManager }) {
        const stream = context.streamerManager.getStreamer(viewName);
        if (!stream) {
          throw new Error(`No streamer found for view: ${viewName}`);
        }
        
        for await (const event of stream.getUpdates()) {
          const payload = { [viewName]: event.row };
          logger.debug({
            component: 'graphql-subscription',
            viewName,
            eventType: event.type,
            data: truncateForLog(event.row)
          }, 'Sending subscription update to client');
          yield payload;
        }
      },
      resolve: (payload: Record<string, unknown>) => {
        return payload[viewName];
      },
    };
  }
}