import { Module, Logger } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { YogaDriver, YogaDriverConfig } from '@graphql-yoga/nestjs';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { generateSchema } from './schema';
import type { SourceConfiguration } from '../config/source.types';
import { buildSubscriptionResolvers } from './subscription.resolver';
import { ViewModule } from '../view/view.module';
import { ViewService } from '../view/view.service';
import { SubscriptionService } from './subscription.service';

/**
 * API module provides GraphQL subscriptions
 * Handles real-time data streaming
 */
@Module({
  imports: [
    ViewModule,
    GraphQLModule.forRootAsync<YogaDriverConfig>({
      driver: YogaDriver,
      imports: [ConfigModule, ViewModule],
      /**
       * Factory function runs after ConfigModule loads source definitions
       * Generates schema and resolvers dynamically from config
       */
      useFactory: (configService: ConfigService, viewService: ViewService) => {
        const logger = new Logger('GraphQLModule');

        // Get source configuration from config
        const sourceConfig = configService.get<SourceConfiguration>(
          'sources',
        ) || { sources: new Map(), enums: new Map() };

        // Generate SDL from source configuration
        const typeDefs = generateSchema(sourceConfig);

        // Log the generated SDL
        logger.log(`Generated GraphQL SDL:\n${typeDefs}`);

        // Create service instances for resolvers
        const subscriptionService = new SubscriptionService(viewService);

        // Build resolvers
        const subscriptionResolvers = buildSubscriptionResolvers(
          sourceConfig.sources,
          subscriptionService,
        );

        const graphqlConfig = configService.get('graphql');
        logger.log(
          `GraphQL: Port ${graphqlConfig.port}, Playground ${graphqlConfig.playground ? 'enabled' : 'disabled'}`,
        );

        // Subscriptions are served over SSE, Yoga's default. Leaving the
        // driver's `subscriptions` option unset keeps WebSockets off.
        return {
          typeDefs,
          graphiql: graphqlConfig.playground, // GRAPHQL_UI turns on the GraphiQL UI
          maskedErrors: false, // Send resolver error messages to clients, as Apollo did
          resolvers: {
            Query: {
              ping: () => 'pong',
            },
            Subscription: subscriptionResolvers,
          },
        };
      },
      inject: [ConfigService, ViewService],
    }),
  ],
  controllers: [],
})
export class ApiModule {}
