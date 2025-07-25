import { Module, Logger } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { generateSchema } from './schema-generator';
import type { SourceDefinition } from '../config/source-definition.types';
import { buildSubscriptionResolvers } from './subscription-resolvers';
import { DatabaseModule } from '../database/database.module';
import { DatabaseStreamingManagerService } from '../database/database-streaming-manager.service';

@Module({
  imports: [
    DatabaseModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule, DatabaseModule],
      useFactory: async (configService: ConfigService, streamingManager: DatabaseStreamingManagerService) => {
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
      inject: [ConfigService, DatabaseStreamingManagerService],
    }),
  ],
  providers: [],
})
export class GraphqlModule {}