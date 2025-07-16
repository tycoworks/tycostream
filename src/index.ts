import { loadDatabaseConfig, loadSchema, ConfigError, getGraphQLPort } from './config.js';
import { MaterializeStreamer } from './materialize.js';
import { GraphQLServer } from './graphqlServer.js';
import { logger } from '../shared/logger.js';
import { shutdownManager } from './shutdown.js';

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
    const schema = loadSchema();
    log.info('Schema loaded', {
      primaryKeyField: schema.primaryKeyField,
      fieldsCount: schema.fields.length,
      viewName: schema.viewName
    });

    // Phase 3: Create streaming components
    log.info('Initializing streaming components');
    const streamer = new MaterializeStreamer(dbConfig, schema);
    log.info('Components initialized');

    // Phase 4: Connect to Materialize
    log.info('Connecting to Materialize');
    await streamer.connect();
    log.info('Connected to Materialize');

    // Phase 5: Start streaming from view
    log.info('Starting view subscription', { databaseViewName: schema.databaseViewName });
    await streamer.startStreaming(schema.databaseViewName);
    log.info('View subscription started');

    // Phase 6: Start GraphQL server
    log.info('Starting GraphQL server');
    const port = getGraphQLPort();
    const graphqlServer = new GraphQLServer(schema, schema.viewName, streamer, port);
    await graphqlServer.start();
    log.info('GraphQL server started', { port });

    // Register shutdown handlers
    shutdownManager.addHandler(async () => {
      await graphqlServer.stop();
    });

    shutdownManager.addHandler(async () => {
      await streamer.stopStreaming();
    });

    shutdownManager.addHandler(async () => {
      await streamer.disconnect();
    });

    log.info('tycostream is ready', {
      graphqlEndpoint: `http://localhost:${port}/graphql`,
      subscriptionsEndpoint: `ws://localhost:${port}/graphql`,
      graphqlTypeName: schema.viewName,
      databaseViewName: schema.databaseViewName
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