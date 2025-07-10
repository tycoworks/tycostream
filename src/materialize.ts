import { Client } from 'pg';
import { from as copyFrom, to as copyTo } from 'pg-copy-streams';
import type { DatabaseConfig, StreamEvent, SchemaField } from '../shared/types.js';
import { logger, truncateForLog } from '../shared/logger.js';

// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops
import { ViewCache } from '../shared/viewCache.js';
import { pubsub, type PubSub } from './pubsub.js';
import { EVENTS } from '../shared/events.js';
import type { GraphQLServer } from './yoga.js';

export class MaterializeStreamer {
  private client: Client | null = null;
  private log = logger.child({ component: 'materialize' });
  private isConnected = false;
  private isStreaming = false;
  private isShuttingDown = false;
  private copyStream: any = null;
  private viewCache: ViewCache;
  private graphqlServer: GraphQLServer | null = null;

  constructor(
    private config: DatabaseConfig,
    private viewName: string,
    primaryKeyField: string,
    private eventBus: PubSub = pubsub,
    viewCache?: ViewCache,
    private schemaFields?: SchemaField[]
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
        connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
        query_timeout: 0, // No timeout for streaming queries
        keepAlive: true,
        keepAliveInitialDelayMillis: DB_KEEP_ALIVE_DELAY_MS,
      });

      this.client.on('error', async (error) => {
        this.log.error('Database connection error', {}, error);
        await this.handleConnectionError(error);
      });

      this.client.on('end', () => {
        this.log.warn('Database connection closed');
        this.isConnected = false;
        this.eventBus.publish(EVENTS.STREAM_DISCONNECTED, { viewName: this.viewName });
      });

      await this.client.connect();
      this.isConnected = true;

      this.log.info('Connected to Materialize');
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

      // Get column structure for COPY output parsing from SDL schema
      this.setupColumnStructure();

      // Start streaming subscription with initial snapshot using COPY
      const subscribeQuery = `COPY (SUBSCRIBE TO ${this.viewName} WITH (SNAPSHOT)) TO STDOUT`;
      this.log.debug('Executing streaming SUBSCRIBE query', { query: subscribeQuery });

      // Use pg-copy-streams for proper COPY streaming (like the Rust implementation)
      const copyToStream = copyTo(subscribeQuery);
      this.copyStream = this.client.query(copyToStream);

      // Handle stream data line by line
      this.copyStream.on('data', (chunk: Buffer) => {
        try {
          const lines = chunk.toString('utf8').split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine) {
              this.log.debug('Raw COPY data received', { 
                viewName: this.viewName, 
                line: trimmedLine
              });
              this.handleCopyLine(trimmedLine);
            }
          }
        } catch (error) {
          this.log.error('Error processing COPY data', { viewName: this.viewName }, error as Error);
        }
      });

      this.copyStream.on('end', () => {
        this.log.warn('COPY stream ended', { viewName: this.viewName });
        this.isStreaming = false;
      });

      this.copyStream.on('error', async (error: Error) => {
        if (!this.isShuttingDown) {
          this.log.error('COPY stream error', { viewName: this.viewName }, error);
          await this.handleStreamError(error);
        }
        // During shutdown, stream errors are expected and ignored
      });

      this.isStreaming = true;
      this.log.info('Stream subscription started', { viewName: this.viewName });

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
        this.log.info('Disconnected from Materialize');
      } catch (error) {
        this.log.error('Error during disconnect', {}, error as Error);
      } finally {
        this.client = null;
        this.isConnected = false;
      }
    }
  }

  private setupColumnStructure(): void {
    if (!this.schemaFields) {
      throw new Error('Schema fields not provided to MaterializeStreamer');
    }

    // COPY (SUBSCRIBE...) output format is: [mz_timestamp, diff, ...view_columns...]
    // So we need to put metadata columns first, then SDL schema fields
    this.columnNames = ['mz_timestamp', 'diff'];
    
    // Add SDL schema fields (in order they're defined)
    this.columnNames.push(...this.schemaFields.map(field => field.name));

    this.log.debug('Set up column structure for COPY SUBSCRIBE output', { 
      viewName: this.viewName,
      columnCount: this.columnNames.length,
      columns: this.columnNames
    });
  }

  private async validateView(): Promise<void> {
    if (!this.client) {
      throw new Error('No database connection');
    }

    try {
      // Check tables first
      const tableResult = await this.client.query(
        'SELECT schemaname, tablename FROM pg_tables WHERE tablename = $1',
        [this.viewName]
      );

      if (tableResult.rows.length === 0) {
        // Check regular views
        const viewResult = await this.client.query(
          'SELECT schemaname, viewname FROM pg_views WHERE viewname = $1',
          [this.viewName]
        );

        if (viewResult.rows.length === 0) {
          // Check Materialize materialized views
          const mvResult = await this.client.query(
            'SELECT name FROM mz_materialized_views WHERE name = $1',
            [this.viewName]
          );

          if (mvResult.rows.length === 0) {
            throw new Error(`View or table '${this.viewName}' does not exist`);
          }
        }
      }

      this.log.info('View validation successful', { viewName: this.viewName });
    } catch (error) {
      this.log.error('View validation failed', { viewName: this.viewName }, error as Error);
      throw error;
    }
  }

  private handleCopyLine(line: string): void {
    try {
      // Parse tab-separated COPY output
      const fields = line.split('\t');
      
      // Map fields to column names using dynamically retrieved structure
      const row: Record<string, any> = {};
      
      fields.forEach((field, index) => {
        if (index < this.columnNames.length) {
          const columnName = this.columnNames[index];
          if (columnName) {
            row[columnName] = field === '\\N' ? null : field;
          }
        }
      });

      const rowSample = truncateForLog(row);
      this.log.debug(`Parsed COPY line into row: ${rowSample}`, { 
        viewName: this.viewName,
        rowKeys: Object.keys(row),
        expectedColumns: this.columnNames.length,
        actualFields: fields.length
      });

      this.handleStreamRow(row);
    } catch (error) {
      this.log.error('Error parsing COPY line', { 
        viewName: this.viewName,
        line: line,
        columnNames: this.columnNames
      }, error as Error);
    }
  }

  private handleStreamRow(row: any): void {
    try {
      this.eventBus.publish(EVENTS.STREAM_UPDATE_RECEIVED, { viewName: this.viewName, row });
      
      // Materialize SUBSCRIBE format: includes 'diff' column (1 = insert/update, -1 = delete)
      // and 'mz_timestamp' column (excluded from cached data)
      // COPY output comes as strings, so parse the diff value
      const diffRaw = row.diff;
      if (diffRaw === undefined || diffRaw === null) {
        this.log.warn('Received invalid data from Materialize view', { 
          viewName: this.viewName, 
          rowKeys: Object.keys(row),
          issue: 'Missing diff column - check view compatibility'
        });
        return;
      }
      
      const diff = parseInt(diffRaw.toString(), 10);
      if (isNaN(diff)) {
        this.log.warn('Received invalid diff value from Materialize view', { 
          viewName: this.viewName, 
          diffValue: diffRaw,
          issue: 'Invalid diff column value'
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

      this.log.debug('Stream processing', {
        viewName: this.viewName,
        diff,
        cacheSize: this.viewCache.size()
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
      this.log.error('Failed to process data from Materialize view', { 
        viewName: this.viewName,
        row: JSON.stringify(row)
      }, error as Error);
    }
  }

  private async handleConnectionError(error: Error): Promise<void> {
    this.log.error('Database connection lost, tycostream will exit', { 
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
    this.log.error('Database connection failed - restart tycostream and check Materialize server status');
    process.exit(1);
  }

  private async handleStreamError(error: Error): Promise<void> {
    this.log.error('View streaming failed, tycostream will exit', { 
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
    this.log.error('View streaming failed - restart tycostream and verify view exists in Materialize');
    process.exit(1);
  }

  private async gracefulShutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.log.info('Beginning graceful shutdown');
    
    if (this.graphqlServer) {
      try {
        this.log.info('Closing GraphQL subscriptions');
        await this.graphqlServer.stop();
        this.log.info('GraphQL server shut down gracefully');
      } catch (error) {
        this.log.error('Failed to shutdown GraphQL server gracefully', {}, error as Error);
      }
    }
    
    // Properly close the COPY stream before closing the connection
    if (this.copyStream) {
      try {
        this.log.debug('Closing COPY stream');
        this.copyStream.destroy();
        this.copyStream = null;
        this.isStreaming = false;
      } catch (error) {
        this.log.debug('Error closing COPY stream (may already be closed)', {}, error as Error);
      }
    }
    
    if (this.client) {
      try {
        this.log.info('Closing Materialize connection');
        await this.client.end();
        this.log.info('Materialize connection closed');
      } catch (error) {
        this.log.error('Failed to close Materialize connection gracefully', {}, error as Error);
      }
    }
  }

  private columnNames: string[] = [];

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