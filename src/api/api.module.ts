import { Module, Logger } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { generateSchema } from './schema';
import type { SourceDefinition } from '../config/source.types';
import { buildSubscriptionResolvers } from './subscription.resolver';
import { ViewModule } from '../view/view.module';
import { ViewService } from '../view/view.service';
import { SubscriptionService } from './subscription.service';
import { buildTriggerResolvers } from './trigger.resolver';
import { TriggerService } from './trigger.service';

/**
 * API module provides GraphQL subscriptions
 * Handles real-time data streaming
 */
@Module({
  imports: [
    ViewModule,
    HttpModule,
    GraphQLModule.forRootAsync<ApolloDriverConfig>({
      driver: ApolloDriver,
      imports: [ConfigModule, ViewModule],
      /**
       * Factory function runs after ConfigModule loads source definitions
       * Generates schema and resolvers dynamically from config
       */
      useFactory: async (configService: ConfigService, viewService: ViewService) => {
        const logger = new Logger('GraphQLModule');
        
        // Get source definitions from config
        const sources = configService.get<Map<string, SourceDefinition>>('sources') || new Map();
        
        // Generate SDL from source definitions
        const typeDefs = generateSchema(sources);
        
        // Log the generated SDL
        logger.log(`Generated GraphQL SDL:\n${typeDefs}`);
        
        // Create service instances for resolvers
        const subscriptionService = new SubscriptionService(viewService);
        const triggerService = new TriggerService(viewService);
        
        // Build resolvers
        const subscriptionResolvers = buildSubscriptionResolvers(sources, subscriptionService);
        const { mutationResolvers, queryResolvers } = buildTriggerResolvers(sources, triggerService);
        
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
          introspection: true, // Always enable introspection for API discovery
          csrfPrevention: true, // Always enabled - Apollo Sandbox handles this properly
          plugins: [landingPagePlugin],
          subscriptions: {
            'graphql-ws': true,
            'subscriptions-transport-ws': true,
          },
          resolvers: {
            Query: queryResolvers,
            Mutation: mutationResolvers,
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
      inject: [ConfigService, ViewService],
    }),
  ],
  controllers: [],
})
export class ApiModule {}