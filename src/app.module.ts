import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';
import graphqlConfig from './config/graphql.config';
import appConfig from './config/app.config';
import sourcesConfig from './config/sources.config';
import { validateConfig } from './config/config.validation';
import { DatabaseModule } from './database/database.module';
import { GraphqlModule } from './graphql/graphql.module';

@Module({
  imports: [
    // Configuration - loaded first, available globally
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      load: [appConfig, databaseConfig, graphqlConfig, sourcesConfig],
      validate: validateConfig,
    }),

    // Core modules - order matters for dependencies
    DatabaseModule,    // Handles database connections and streaming
    GraphqlModule,     // Exposes GraphQL subscriptions
  ],
})
export class AppModule {}