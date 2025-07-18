import { loadDatabaseConfig, loadGraphQLSchema, ConfigError, getGraphQLPort } from './core/config.js';
import { GraphQLServer } from './graphql/server.js';
import { logger } from './core/logger.js';
import { shutdownManager } from './core/shutdown.js';

async function main(): Promise<void> {
  const log = logger.child({ component: 'main' });
  
   try {
    log.info('Starting tycostream');

    // Phase 1: Load and validate configuration
    log.info('Loading configuration');
    const dbConfig = loadDatabaseConfig();
    log.info('Database configuration loaded', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database
    });

    // Phase 2: Load and validate schema
    log.info('Loading schema');
    const schema = loadGraphQLSchema();
    log.info('Schema loaded', {
      sourceCount: schema.sources.size,
      sources: Array.from(schema.sources.keys())
    });

    // Phase 3: Start GraphQL server (which will create its own database streamer)
    log.info('Starting GraphQL server');
    const port = getGraphQLPort();
    const graphqlServer = new GraphQLServer(dbConfig, schema, port);
    await graphqlServer.start();
    log.info('GraphQL server started', { port });

    // Register shutdown handler
    shutdownManager.addHandler(async () => {
      await graphqlServer.stop();
    });

    log.info('tycostream is ready', {
      graphqlEndpoint: `http://localhost:${port}/graphql`,
      subscriptionsEndpoint: `ws://localhost:${port}/graphql`,
      sources: Array.from(schema.sources.keys())
    });

  } catch (error) {
    if (error instanceof ConfigError) {
      log.error(`Configuration error: ${error.message}`, { 
        field: error.field,
        errorType: 'ConfigError' 
      });
      process.exit(1);
    } else {
      log.error(`Startup failed: ${(error as Error).message}`, { 
        errorType: (error as Error).name,
        stack: (error as Error).stack
      });
      process.exit(1);
    }
  }
}

// Handle unexpected async errors
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unexpected error occurred', { reason: String(reason) });
  logger.error('Please restart tycostream and check your configuration');
  process.exit(1);
});

// Handle unexpected system errors
process.on('uncaughtException', (error) => {
  logger.error('Critical system error occurred', {}, error);
  logger.error('Please restart tycostream and check your configuration');
  process.exit(1);
});

// Start the application
main().catch((error) => {
  logger.error('tycostream failed to start', {}, error);
  logger.error('Check your .env file and Materialize connection settings');
  process.exit(1);
});