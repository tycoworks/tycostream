import { Client } from 'pg';
import QueryStream from 'pg-query-stream';
import type { DatabaseConfig, StreamEvent } from '../shared/types.js';
import { logger } from '../shared/logger.js';
import { ViewCache } from '../shared/viewCache.js';
import { pubsub, type PubSub } from './pubsub.js';
import { EVENTS } from '../shared/events.js';
import type { GraphQLServer } from './yoga.js';

export class MaterializeStreamer {
  private client: Client | null = null;
  private log = logger.child({ component: 'materialize' });
  private isConnected = false;
  private isStreaming = false;
  private viewCache: ViewCache;
  private graphqlServer: GraphQLServer | null = null;

  constructor(
    private config: DatabaseConfig,
    private viewName: string,
    primaryKeyField: string,
    private eventBus: PubSub = pubsub,
    viewCache?: ViewCache
  ) {
    this.viewCache = viewCache || new ViewCache(primaryKeyField, viewName);
  }

  setGraphQLServer(server: GraphQLServer): void {
    this.graphqlServer = server;
  }

  async connect(): Promise<void> {
    try {
      this.log.info('Connecting to Materialize', { 
        host: this.config.host, 
        port: this.config.port,
        database: this.config.database,
        user: this.config.user
      });

      this.client = new Client({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        // Connection timeout and keep-alive settings
        connectionTimeoutMillis: 10000,
        query_timeout: 0, // No timeout for streaming queries
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });

      this.client.on('error', async (error) => {
        this.log.error('Postgres client error', {}, error);
        await this.handleConnectionError(error);
      });

      this.client.on('end', () => {
        this.log.warn('Postgres connection ended');
        this.isConnected = false;
        this.eventBus.publish(EVENTS.STREAM_DISCONNECTED, { viewName: this.viewName });
      });

      await this.client.connect();
      this.isConnected = true;

      this.log.info('Connected to Materialize successfully');
      this.eventBus.publish(EVENTS.STREAM_CONNECTED, { viewName: this.viewName });

    } catch (error) {
      this.log.error('Failed to connect to Materialize', {}, error as Error);
      throw new Error(`Database connection failed: ${(error as Error).message}`);
    }
  }

  async startStreaming(): Promise<void> {
    if (!this.client || !this.isConnected) {
      throw new Error('Must connect to database before starting stream');
    }

    if (this.isStreaming) {
      this.log.warn('Stream already active', { viewName: this.viewName });
      return;
    }

    try {
      this.log.info('Starting stream subscription', { viewName: this.viewName });
      
      // First, validate that the view exists
      await this.validateView();

      // Start the SUBSCRIBE query with proper streaming
      const subscribeQuery = `SUBSCRIBE (SELECT * FROM ${this.viewName}) WITH (SNAPSHOT)`;
      this.log.debug('Executing SUBSCRIBE query', { query: subscribeQuery });

      // Use pg's streaming interface for long-running queries
      const query = new QueryStream(subscribeQuery);
      const stream = this.client.query(query);
      
      // Handle streaming rows as they arrive
      stream.on('data', (row: any) => {
        this.handleStreamRow(row);
      });

      stream.on('error', async (error: Error) => {
        this.log.error('SUBSCRIBE query error', { viewName: this.viewName }, error);
        await this.handleStreamError(error);
      });

      stream.on('end', () => {
        this.log.warn('SUBSCRIBE stream ended unexpectedly', { viewName: this.viewName });
        this.isStreaming = false;
      });

      this.isStreaming = true;
      this.log.info('Stream subscription started successfully', { viewName: this.viewName });

    } catch (error) {
      this.log.error('Failed to start streaming', { viewName: this.viewName }, error as Error);
      throw new Error(`Stream initialization failed: ${(error as Error).message}`);
    }
  }

  async disconnect(): Promise<void> {
    this.log.info('Disconnecting from Materialize');
    
    this.isShuttingDown = true;
    this.isStreaming = false;
    
    if (this.client) {
      try {
        await this.client.end();
        this.log.info('Disconnected from Materialize successfully');
      } catch (error) {
        this.log.error('Error during disconnect', {}, error as Error);
      } finally {
        this.client = null;
        this.isConnected = false;
      }
    }
  }

  private async validateView(): Promise<void> {
    if (!this.client) {
      throw new Error('No database connection');
    }

    try {
      const result = await this.client.query(
        'SELECT schemaname, tablename FROM pg_tables WHERE tablename = $1',
        [this.viewName]
      );

      if (result.rows.length === 0) {
        // Also check views
        const viewResult = await this.client.query(
          'SELECT schemaname, viewname FROM pg_views WHERE viewname = $1',
          [this.viewName]
        );

        if (viewResult.rows.length === 0) {
          throw new Error(`View or table '${this.viewName}' does not exist`);
        }
      }

      this.log.debug('View validation successful', { viewName: this.viewName });
    } catch (error) {
      this.log.error('View validation failed', { viewName: this.viewName }, error as Error);
      throw error;
    }
  }

  private handleStreamRow(row: any): void {
    try {
      this.eventBus.publish(EVENTS.STREAM_UPDATE_RECEIVED, { viewName: this.viewName, row });
      
      // Materialize SUBSCRIBE format: includes 'diff' column (1 = insert/update, -1 = delete)
      // and 'mz_timestamp' column (excluded from cached data)
      const diff = row.diff;
      if (typeof diff !== 'number') {
        this.log.warn('Received row without valid diff column', { 
          viewName: this.viewName, 
          rowKeys: Object.keys(row) 
        });
        return;
      }

      // Extract actual row data (exclude Materialize metadata columns)
      const rowData = { ...row };
      delete rowData.diff;
      delete rowData.mz_timestamp;

      const streamEvent: StreamEvent = {
        row: rowData,
        diff,
      };

      this.log.debug('Processing stream event', {
        viewName: this.viewName,
        diff,
        rowKeys: Object.keys(rowData)
      });

      // Update view cache with the stream event
      this.viewCache.applyStreamEvent(streamEvent);

      // Publish to subscribers
      this.eventBus.publishStreamEvent(this.viewName, streamEvent);
      this.eventBus.publish(EVENTS.STREAM_UPDATE_PARSED, { 
        viewName: this.viewName, 
        diff,
        rowKeys: Object.keys(rowData),
        cacheSize: this.viewCache.size()
      });

    } catch (error) {
      this.log.error('Error processing stream row', { 
        viewName: this.viewName,
        row: JSON.stringify(row)
      }, error as Error);
    }
  }

  private async handleConnectionError(error: Error): Promise<void> {
    this.log.error('❌ Fatal connection error - service will exit', { 
      viewName: this.viewName,
      host: this.config.host,
      port: this.config.port
    }, error);
    
    this.isConnected = false;
    this.isStreaming = false;
    
    this.eventBus.publish(EVENTS.STREAM_ERROR, { 
      viewName: this.viewName, 
      error: error.message,
      errorType: 'connection'
    });

    // Graceful shutdown before exit
    await this.gracefulShutdown();
    this.log.error('🔌 Materialize connection lost - restart tycostream to resume service');
    process.exit(1);
  }

  private async handleStreamError(error: Error): Promise<void> {
    this.log.error('❌ Fatal stream error - service will exit', { 
      viewName: this.viewName 
    }, error);
    
    this.isStreaming = false;
    
    this.eventBus.publish(EVENTS.STREAM_ERROR, { 
      viewName: this.viewName, 
      error: error.message,
      errorType: 'stream'
    });

    // Graceful shutdown before exit
    await this.gracefulShutdown();
    this.log.error('📡 Materialize stream failed - restart tycostream to resume service');
    process.exit(1);
  }

  private async gracefulShutdown(): Promise<void> {
    this.log.info('🔄 Beginning graceful shutdown');
    
    if (this.graphqlServer) {
      try {
        this.log.info('📡 Closing GraphQL subscriptions');
        await this.graphqlServer.stop();
        this.log.info('✅ GraphQL server shut down gracefully');
      } catch (error) {
        this.log.error('Failed to shutdown GraphQL server gracefully', {}, error as Error);
      }
    }
    
    if (this.client) {
      try {
        this.log.info('🔌 Closing Materialize connection');
        await this.client.end();
        this.log.info('✅ Materialize connection closed');
      } catch (error) {
        this.log.error('Failed to close Materialize connection gracefully', {}, error as Error);
      }
    }
  }

  private isShuttingDown = false;

  get connected(): boolean {
    return this.isConnected;
  }

  get streaming(): boolean {
    return this.isStreaming;
  }

  get cache(): ViewCache {
    return this.viewCache;
  }
}