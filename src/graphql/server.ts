import { makeExecutableSchema } from '@graphql-tools/schema';
import type { LoadedSchema } from '../core/schema.js';
import { logger } from '../core/logger.js';
import type { DatabaseStreamer } from '../database/types.js';
import type { DatabaseConfig } from '../core/config.js';
import { isGraphQLUIEnabled } from '../core/config.js';
import { MaterializeStreamer } from '../database/materialize.js';
import { createViewSubscriptionResolver, createViewQueryResolver } from './resolvers.js';
import { createGraphQLServers, type GraphQLServers } from './setup.js';

// Component-specific configuration
const DEFAULT_GRAPHQL_PORT = 4000;

export class GraphQLServer {
  private log = logger.child({ component: 'graphql' });
  private servers: GraphQLServers | null = null;
  private stream: DatabaseStreamer | null = null;

  constructor(
    private dbConfig: DatabaseConfig,
    private schema: LoadedSchema,
    private viewName: string,
    private port: number = DEFAULT_GRAPHQL_PORT
  ) {}

  async start(): Promise<void> {
    try {
      this.log.info('Starting GraphQL server', { port: this.port, viewName: this.viewName });

      // Create and start the database streamer
      this.stream = new MaterializeStreamer(this.dbConfig, this.schema);
      await this.stream.start();
      this.log.debug('Database streamer created and started');

      const schema = this.buildGraphQLSchema();
      
      // Create HTTP and WebSocket servers
      this.servers = createGraphQLServers(
        schema,
        {
          viewName: this.viewName,
          stream: this.stream!,
          primaryKeyField: this.schema.primaryKeyField,
        },
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
    
    if (this.stream) {
      await this.stream.stop();
      this.stream = null;
    }
    
    this.log.info('GraphQL server stopped');
  }

  private buildGraphQLSchema() {
    const resolvers = {
      Query: {
        [this.viewName]: createViewQueryResolver()
      },
      Subscription: {
        [this.viewName]: createViewSubscriptionResolver(this.viewName)
      },
    };

    return makeExecutableSchema({
      typeDefs: this.schema.typeDefs,
      resolvers
    });
  }
}