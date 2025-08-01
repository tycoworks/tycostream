import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import graphqlConfig from './config/graphql.config';
import sourcesConfig from './config/sources.config';
import { DatabaseModule } from './database/database.module';
import { StreamingModule } from './streaming/streaming.module';
import { GraphqlModule } from './graphql/graphql.module';

/**
 * Root application module that bootstraps the tycostream server
 * Module order matters: Config → Database → Streaming → GraphQL
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
    StreamingModule,   // Streaming domain logic
    GraphqlModule,     // GraphQL API layer
  ],
})
export class AppModule {}