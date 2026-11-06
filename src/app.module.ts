import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config.js';
import graphqlConfig from './config/graphql.config.js';
import sourcesConfig from './config/sources.config.js';
import { DatabaseModule } from './database/database.module.js';
import { ViewModule } from './view/view.module.js';
import { ApiModule } from './api/api.module.js';

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
    DatabaseModule, // Database infrastructure
    ViewModule, // View domain logic (filtered streams)
    ApiModule, // API layer (GraphQL subscriptions)
  ],
})
export class AppModule {}
