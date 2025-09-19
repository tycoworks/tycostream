/**
 * tycostream entry point - starts the GraphQL server
 * Loads configuration, initializes database streaming, and serves subscriptions
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { getLogLevels } from './common/logging.utils';

/**
 * Bootstrap the NestJS application
 * Initializes the server with configuration, database connections, and GraphQL endpoint
 */
async function bootstrap() {
  const logger = new Logger('tycostream');
  
  // Handle uncaught exceptions and unhandled rejections
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    process.exit(1);
  });
  
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled rejection at:', promise, 'reason:', reason);
    process.exit(1);
  });
  
  try {
    const app = await NestFactory.create(AppModule, {
      logger: getLogLevels(process.env.LOG_LEVEL),
    });

    logger.log('=== tycostream starting ===');

    // Start the HTTP server on the configured port
    const port = parseInt(process.env.GRAPHQL_PORT || '4000', 10);
    await app.listen(port);
    logger.log('=== tycostream ready ===');
    
  } catch (error) {
    logger.error('Failed to start tycostream');
    console.error(error); // Log full error to console before exit
    process.exit(1);
  }
}

bootstrap();