import { loadDatabaseConfig, loadSchema, ConfigError } from './config.js';
import { MaterializeStreamer } from './materialize.js';
import { GraphQLServer } from './yoga.js';
import { logger } from '../../shared/logger.js';
import { shutdownManager } from '../../shared/shutdown.js';
import { EVENTS } from '../../shared/events.js';
import { pubsub } from './pubsub.js';

async function main(): Promise<void> {
  const log = logger.child({ component: 'main' });
  
  try {
    log.info('🚀 tycostream starting...');

    // Phase 1: Load and validate configuration
    log.info('📋 Loading configuration...');
    const dbConfig = loadDatabaseConfig();
    log.info('✅ Database configuration loaded', {
      host: dbConfig.host,
      port: dbConfig.port,
      database: dbConfig.database,
      viewName: dbConfig.viewName
    });

    // Phase 2: Load and validate schema
    log.info('📄 Loading schema...', { viewName: dbConfig.viewName });
    const schema = loadSchema(dbConfig.viewName);
    log.info('✅ Schema loaded successfully', {
      primaryKeyField: schema.primaryKeyField,
      fieldsCount: schema.fields.length
    });
    pubsub.publish(EVENTS.SCHEMA_LOADED, { viewName: dbConfig.viewName, schema });

    // Phase 3: Connect to Materialize
    log.info('🔌 Connecting to Materialize...');
    const streamer = new MaterializeStreamer(dbConfig, schema.primaryKeyField);
    await streamer.connect();
    log.info('✅ Connected to Materialize successfully');

    // Phase 4: Start streaming from view
    log.info('📡 Starting view subscription...', { viewName: dbConfig.viewName });
    await streamer.startStreaming();
    log.info('✅ View subscription started successfully');

    // Phase 5: Start GraphQL server
    log.info('🌐 Starting GraphQL server...');
    const graphqlServer = new GraphQLServer(schema, dbConfig.viewName, streamer.cache, 4000);
    await graphqlServer.start();
    log.info('✅ GraphQL server started successfully');

    // Register shutdown handlers
    shutdownManager.addHandler(async () => {
      log.info('🛑 Shutting down GraphQL server...');
      await graphqlServer.stop();
    });

    shutdownManager.addHandler(async () => {
      log.info('🛑 Disconnecting from Materialize...');
      await streamer.disconnect();
    });

    log.info('🎉 tycostream is ready!', {
      graphqlEndpoint: 'http://localhost:4000/graphql',
      subscriptionsEndpoint: 'ws://localhost:4000/graphql',
      viewName: dbConfig.viewName
    });

  } catch (error) {
    if (error instanceof ConfigError) {
      log.error('❌ Configuration error - exiting', { field: error.field }, error);
      process.exit(1);
    } else {
      log.error('❌ Startup failed - exiting', {}, error as Error);
      process.exit(1);
    }
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason: String(reason) });
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', {}, error);
  process.exit(1);
});

// Start the application
main().catch((error) => {
  logger.error('Failed to start tycostream', {}, error);
  process.exit(1);
});