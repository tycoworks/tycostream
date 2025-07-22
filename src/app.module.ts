import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import graphqlConfig from './config/graphql.config';
import appConfig from './config/app.config';
import { DatabaseModule } from './database/database.module';
import { SchemaModule } from './schema/schema.module';
import { GraphqlModule } from './graphql/graphql.module';

@Module({
  imports: [
    // Configuration - loaded first, available globally
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, graphqlConfig],
    }),

    // Core modules - order matters for dependencies
    DatabaseModule,    // Handles database connections and streaming
    SchemaModule,      // Loads and validates YAML schemas
    GraphqlModule,     // Exposes GraphQL subscriptions
  ],
})
export class AppModule {}