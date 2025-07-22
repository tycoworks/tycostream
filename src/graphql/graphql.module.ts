import { Module, Logger } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
        
        return {
          typeDefs,
          playground: true,
          introspection: true,
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
        };
      },
      inject: [ConfigService, DatabaseStreamingManagerService],
    }),
  ],
  providers: [],
})
export class GraphqlModule {}