import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import graphqlConfig from './config/graphql.config';
import sourcesConfig from './config/sources.config';
import { DatabaseModule } from './database/database.module';
import { ViewModule } from './view/view.module';
import { ApiModule } from './api/api.module';

/**
 * Root application module that bootstraps the tycostream server
 * Module order matters: Config → Database → View → API
 */
@Module({
  imports: [
    // Configuration - loaded first, available globally
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [databaseConfig, graphqlConfig, sourcesConfig],
    }),

    // Core modules - order matters for dependencies
    DatabaseModule,    // Database infrastructure
    ViewModule,        // View domain logic (filtered streams)
    ApiModule,         // API layer (GraphQL subscriptions & REST triggers)
  ],
})
export class AppModule {}