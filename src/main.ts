import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import type { SourceDefinition } from './config/source-definition.types';

async function bootstrap() {
  const logger = new Logger('tycostream');
  
  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

    logger.log('=== tycostream starting ===');
    
    const dbConfig = configService.get('database');
    logger.log(`Database config: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    
    const graphqlConfig = configService.get('graphql');
    logger.log(`GraphQL port: ${graphqlConfig.port}, Playground: ${graphqlConfig.playground ? 'enabled' : 'disabled'}`);
    
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

    // Start the HTTP server
    await app.listen(graphqlConfig.port);
    logger.log(`GraphQL server running at http://localhost:${graphqlConfig.port}/graphql`);
    
  } catch (error) {
    logger.error('Failed to start tycostream', error);
    process.exit(1);
  }
}

bootstrap();