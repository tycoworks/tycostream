import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  
  try {
    const app = await NestFactory.create(AppModule);
    const configService = app.get(ConfigService);

    // Phase 1: Just log that configuration loaded successfully
    logger.log('=== Tycostream Starting ===');
    
    const dbConfig = configService.get('database');
    logger.log(`Database config: ${dbConfig.user}@${dbConfig.host}:${dbConfig.port}/${dbConfig.database}`);
    
    const graphqlConfig = configService.get('graphql');
    logger.log(`GraphQL port: ${graphqlConfig.port}, Playground: ${graphqlConfig.playground ? 'enabled' : 'disabled'}`);
    
    const appConfig = configService.get('app');
    logger.log(`Schema path: ${appConfig.schemaPath}`);

    logger.log('Phase 1 complete - Configuration loaded successfully');

    // TODO: Phase 2 - Database connection
    // TODO: Phase 3 - Schema loading
    // TODO: Phase 4 - GraphQL setup
    // TODO: Phase 5 - Start streaming

    // Don't actually start the HTTP server yet
    // await app.listen(graphqlConfig.port);
    
  } catch (error) {
    logger.error('Failed to start Tycostream', error);
    process.exit(1);
  }
}

bootstrap();