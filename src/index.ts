import { loadDatabaseConfig, loadSchema, ConfigError } from './config.js';
import { MaterializeStreamer } from './materialize.js';
import { GraphQLServer } from './yoga.js';
import { logger } from '../shared/logger.js';
import { shutdownManager } from '../shared/shutdown.js';
import { EVENTS } from '../shared/events.js';
import { pubsub } from './pubsub.js';

async function main(): Promise<void> {
  const log = logger.child({ component: 'main' });
  
   try {
    log.info('tycostream starting');

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
    pubsub.publish(EVENTS.SCHEMA_LOADED, { viewName: schema.viewName, schema });

    // Phase 3: Connect to Materialize
    log.info('Connecting to Materialize');
    const streamer = new MaterializeStreamer(dbConfig, schema.viewName, schema.primaryKeyField, pubsub, undefined, schema.fields);
    await streamer.connect();
    log.info('Connected to Materialize');

    // Phase 4: Start streaming from view
    log.info('Starting view subscription', { viewName: schema.viewName });
    await streamer.startStreaming();
    log.info('View subscription started');

    // Phase 5: Start GraphQL server
    log.info('Starting GraphQL server');
    const port = parseInt(process.env.GRAPHQL_PORT || '4000', 10);
    const graphqlServer = new GraphQLServer(schema, schema.viewName, streamer.cache, port);
    await graphqlServer.start();
    log.info('GraphQL server started', { port });

    // Phase 6: Wire up graceful shutdown coordination
    streamer.setGraphQLServer(graphqlServer);

    // Register shutdown handlers
    shutdownManager.addHandler(async () => {
      log.info('Shutting down GraphQL server');
      await graphqlServer.stop();
    });

    shutdownManager.addHandler(async () => {
      log.info('Disconnecting from Materialize');
      await streamer.disconnect();
    });

    log.info('tycostream is ready', {
      graphqlEndpoint: `http://localhost:${port}/graphql`,
      subscriptionsEndpoint: `ws://localhost:${port}/graphql`,
      viewName: schema.viewName
    });

  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('Configuration error, exiting', { field: error.field }, error);
      process.exit(1);
    } else {
      log.error('Startup failed, exiting', {}, error as Error);
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