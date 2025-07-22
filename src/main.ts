import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import type { SourceDefinition } from './config/sourcedefinition.types';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

    // Phase 1: Configuration
    logger.log('=== Tycostream Starting ===');
    
    const dbConfig = configService.get('database');
    logger.log(`Database config: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    
    const graphqlConfig = configService.get('graphql');
    logger.log(`GraphQL port: ${graphqlConfig.port}, Playground: ${graphqlConfig.playground ? 'enabled' : 'disabled'}`);
    
    // Phase 2a: Source Definitions
    const sources = configService.get<Map<string, SourceDefinition>>('sources');
    if (sources && sources.size > 0) {
      logger.log(`Loaded ${sources.size} source definitions`);
      
      // Log source details
      for (const [name, source] of sources) {
        logger.log(`  - ${name}: ${source.fields.length} fields, primary key: ${source.primaryKeyField}`);
      }
    } else {
      logger.warn('No source definitions loaded');
    }

    logger.log('Phase 2a complete - Configuration and sources loaded');

    // TODO: Phase 2b - Database connection
    // TODO: Phase 3 - Streaming with cache
    // TODO: Phase 4 - GraphQL setup
    // TODO: Phase 5 - Full integration

    // Don't actually start the HTTP server yet
    // await app.listen(graphqlConfig.port);
    
  } catch (error) {
    logger.error('Failed to start Tycostream', error);
    process.exit(1);
  }
}

bootstrap();