import { makeExecutableSchema } from '@graphql-tools/schema';
import type { GraphQLSchema } from '../core/schema.js';
import { logger, truncateForLog } from '../core/logger.js';
import type { DatabaseConfig } from '../core/config.js';
import { isGraphQLUIEnabled } from '../core/config.js';
import { createGraphQLServers, type GraphQLServers } from './setup.js';
import { DatabaseSubscriberManager } from '../database/manager.js';

// Component-specific configuration
const DEFAULT_GRAPHQL_PORT = 4000;

// GraphQL subscription resolver type
type SubscriptionResolver = {
  subscribe: (parent: unknown, args: unknown, context: { subscriberManager: DatabaseSubscriberManager }) => AsyncIterator<unknown>;
  resolve?: (payload: unknown) => unknown;
};

export class GraphQLServer {
  private log = logger.child({ component: 'graphql' });
  private servers: GraphQLServers | null = null;
  private subscriberManager: DatabaseSubscriberManager | null = null;

  constructor(
    private dbConfig: DatabaseConfig,
    private schema: GraphQLSchema,
    private port: number = DEFAULT_GRAPHQL_PORT
  ) {}

  async start(): Promise<void> {
    try {
      this.log.info('Starting GraphQL server', { port: this.port, sourceCount: this.schema.sources.size });

      // Create and start subscriber manager
      this.subscriberManager = new DatabaseSubscriberManager(this.dbConfig, this.schema);
      await this.subscriberManager.start();
      
      this.log.debug('All database subscribers created and started');

      const schema = this.buildGraphQLSchema();
      
      // Create HTTP and WebSocket servers
      this.servers = createGraphQLServers(
        schema,
        this.subscriberManager,
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
    
    if (this.subscriberManager) {
      await this.subscriberManager.stop();
      this.subscriberManager = null;
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

    // Create resolvers for each source
    for (const [sourceName, sourceSchema] of this.schema.sources) {
      resolvers.Subscription[sourceName] = this.createSourceSubscriptionResolver(sourceName);
    }

    return makeExecutableSchema({
      typeDefs: this.schema.typeDefs,
      resolvers
    });
  }

  private createSourceSubscriptionResolver(sourceName: string) {
    return {
      subscribe: async function* (_parent: unknown, _args: unknown, context: { subscriberManager: DatabaseSubscriberManager }) {
        const stream = context.subscriberManager.getSubscriber(sourceName);
        if (!stream) {
          throw new Error(`No streamer found for source: ${sourceName}`);
        }
        
        for await (const event of stream.getUpdates()) {
          const payload = { [sourceName]: event.row };
          logger.debug({
            component: 'graphql-subscription',
            sourceName,
            eventType: event.type,
            data: truncateForLog(event.row)
          }, 'Sending subscription update to client');
          yield payload;
        }
      },
      resolve: (payload: unknown) => {
        return (payload as Record<string, unknown>)[sourceName];
      },
    };
  }
}