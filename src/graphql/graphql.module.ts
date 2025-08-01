import { Module, Logger } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { generateSchema } from './schema';
import type { SourceDefinition } from '../config/source.types';
import { buildSubscriptionResolvers } from './subscriptions';
import { StreamingModule } from '../streaming/streaming.module';
import { StreamingManagerService } from '../streaming/manager.service';

/**
 * GraphQL module configures Apollo Server with dynamic schema generation
 * Runtime schema based on YAML config, supports both WebSocket protocols
 */
@Module({
  imports: [
    StreamingModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule, StreamingModule],
      /**
       * Factory function runs after ConfigModule loads source definitions
       * Generates schema and resolvers dynamically from config
       */
      useFactory: async (configService: ConfigService, streamingManager: StreamingManagerService) => {
        const logger = new Logger('GraphQLModule');
        
        // Get source definitions from config
        const sources = configService.get<Map<string, SourceDefinition>>('sources') || new Map();
        
        // Generate SDL from source definitions
        const typeDefs = generateSchema(sources);
        
        // Log the generated SDL
        logger.log(`Generated GraphQL SDL:\n${typeDefs}`);
        
        // Build subscription resolvers
        const subscriptionResolvers = buildSubscriptionResolvers(sources, streamingManager);
        
        const graphqlConfig = configService.get('graphql');
        
        // Configure landing page plugin based on GRAPHQL_UI environment variable
        const landingPagePlugin = graphqlConfig.playground
          ? ApolloServerPluginLandingPageLocalDefault({
              embed: true,
              includeCookies: true,
            })
          : ApolloServerPluginLandingPageDisabled();
        
        return {
          typeDefs,
          playground: false, // Deprecated in Apollo Server 4, using plugins instead
          introspection: true, // Always enable introspection for API discovery
          csrfPrevention: graphqlConfig.playground ? false : true, // Disable CSRF when playground is enabled
          plugins: [landingPagePlugin],
          subscriptions: {
            'graphql-ws': true,
            'subscriptions-transport-ws': true,
          },
          resolvers: {
            Query: {
              ping: () => 'pong',
            },
            Subscription: subscriptionResolvers,
          },
          // CORS configuration for development when playground is enabled
          ...(graphqlConfig.playground && {
            cors: {
              origin: true,
              credentials: true,
            },
          }),
        };
      },
      inject: [ConfigService, StreamingManagerService],
    }),
  ],
  providers: [],
})
export class GraphqlModule {}