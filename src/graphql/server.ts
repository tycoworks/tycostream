import { makeExecutableSchema } from '@graphql-tools/schema';
import type { LoadedSchema } from '../core/schema.js';
import { logger } from '../core/logger.js';
import type { DatabaseConfig } from '../core/config.js';
import { isGraphQLUIEnabled } from '../core/config.js';
import { createViewSubscriptionResolver, createViewQueryResolver } from './resolvers.js';
import { createGraphQLServers, type GraphQLServers } from './setup.js';
import { StreamerManager } from '../database/streamerManager.js';

// Component-specific configuration
const DEFAULT_GRAPHQL_PORT = 4000;

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
    const resolvers: any = {
      Query: {},
      Subscription: {},
    };

    // Create resolvers for each view
    for (const [viewName, viewSchema] of this.schema.views) {
      resolvers.Query[viewName] = createViewQueryResolver(viewName);
      resolvers.Subscription[viewName] = createViewSubscriptionResolver(viewName);
    }

    return makeExecutableSchema({
      typeDefs: this.schema.typeDefs,
      resolvers
    });
  }
}