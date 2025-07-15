import { Client } from 'pg';
import { to as copyTo } from 'pg-copy-streams';
import type { SchemaField } from '../shared/schema.js';
import type { StreamEvent } from '../shared/viewCache.js';
import type { DatabaseConfig } from './config.js';
import { logger } from '../shared/logger.js';
import { ViewCache } from '../shared/viewCache.js';

// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

/**
 * Pure database connection management
 * Internal utility for streaming database adapters
 */
class DatabaseConnection {
  private log = logger.child({ component: 'database' });

  /**
   * Connect to streaming database
   */
  async connect(config: DatabaseConfig): Promise<Client> {
    this.log.info('Connecting to streaming database', { 
      host: config.host, 
      port: config.port,
      database: config.database,
      user: config.user
    });

    const client = new Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      // Connection timeout and keep-alive settings
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      query_timeout: 0, // No timeout for streaming queries
      keepAlive: true,
      keepAliveInitialDelayMillis: DB_KEEP_ALIVE_DELAY_MS,
    });

    try {
      await client.connect();
      this.log.info('Connected to streaming database');
      return client;
    } catch (error) {
      this.log.error('Failed to connect to streaming database', {}, error as Error);
      throw new Error(`Database connection failed: ${(error as Error).message}`);
    }
  }

  /**
   * Disconnect from database
   */
  async disconnect(client: Client): Promise<void> {
    try {
      await client.end();
      this.log.info('Database connection closed');
    } catch (error) {
      this.log.error('Error during disconnect', {}, error as Error);
      throw error;
    }
  }
}

/**
 * Materialize COPY stream processor
 * Handles buffer chunking, line parsing, and cache updates
 */
class CopyStreamProcessor {
  private log = logger.child({ component: 'parser' });
  private columnNames: string[];

  constructor(
    schemaFields: SchemaField[],
    private cache: ViewCache
  ) {
    // COPY (SUBSCRIBE...) output format is: [mz_timestamp, diff, ...view_columns...]
    this.columnNames = ['mz_timestamp', 'diff', ...schemaFields.map(field => field.name)];

    this.log.debug('COPY processor initialized', { 
      columnCount: this.columnNames.length,
      columns: this.columnNames
    });
  }

  /**
   * Process a chunk of COPY stream data
   */
  processChunk(chunk: Buffer): void {
    try {
      const lines = chunk.toString('utf8').split('\n');
      for (const line of lines) {
        const event = this.parseRow(line);
        if (event) {
          this.cache.applyStreamEvent(event);
        }
      }
    } catch (error) {
      this.log.error('Error processing COPY chunk', {}, error as Error);
    }
  }

  /**
   * Parse a single line of COPY output into a StreamEvent
   */
  private parseRow(line: string): StreamEvent | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const fields = trimmed.split('\t');
    if (fields.length < 2) return null;

    // Parse timestamp (first field)
    const timestampField = fields[0];
    if (!timestampField) return null;
    const timestamp = BigInt(timestampField);

    // Parse diff (second field)
    const diffField = fields[1];
    if (!diffField) return null;
    const diff = parseInt(diffField, 10);
    if (isNaN(diff)) return null;

    // Map remaining fields to row data (skip mz_timestamp and diff)
    const row: Record<string, any> = {};
    for (let i = 2; i < fields.length && i < this.columnNames.length; i++) {
      const columnName = this.columnNames[i];
      const field = fields[i];
      if (columnName && field !== undefined) {
        row[columnName] = field === '\\N' ? null : field;
      }
    }

    return { row, diff, timestamp };
  }
}

/**
 * Materialize streaming database adapter
 * Handles connection management and Materialize-specific streaming protocol
 */
export class MaterializeStreamer {
  private log = logger.child({ component: 'materialize' });
  private isStreaming = false;
  private copyStream: any = null;
  private processor: CopyStreamProcessor;
  private dbConnection = new DatabaseConnection();
  private client: Client | null = null;
  private isShuttingDown = false;

  constructor(
    private config: DatabaseConfig,
    schemaFields: SchemaField[],
    cache: ViewCache
  ) {
    this.processor = new CopyStreamProcessor(schemaFields, cache);
  }

  /**
   * Connect to Materialize database
   */
  async connect(): Promise<void> {
    this.client = await this.dbConnection.connect(this.config);
  }

  /**
   * Disconnect from Materialize database
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.dbConnection.disconnect(this.client);
      this.client = null;
    }
  }

  /**
   * Start streaming from a Materialize view
   */
  async startStreaming(viewName: string): Promise<void> {
    if (!this.client) {
      throw new Error('Must connect to database before starting stream');
    }

    if (this.isStreaming) {
      this.log.warn('Stream already active', { viewName });
      return;
    }

    try {
      this.log.info('Starting stream subscription', { viewName });

      // Start streaming subscription with initial snapshot using COPY
      const subscribeQuery = `COPY (SUBSCRIBE TO ${viewName} WITH (SNAPSHOT)) TO STDOUT`;
      this.log.debug('Executing streaming SUBSCRIBE query', { query: subscribeQuery });

      // Use pg-copy-streams for proper COPY streaming
      const copyToStream = copyTo(subscribeQuery);
      this.copyStream = this.client.query(copyToStream);

      // Handle stream data chunks
      this.copyStream.on('data', (chunk: Buffer) => {
        this.processor.processChunk(chunk);
      });

      this.copyStream.on('end', () => {
        // Only warn about unexpected stream end
        if (!this.isShuttingDown) {
          this.log.warn('COPY stream ended', { viewName });
        }
        this.isStreaming = false;
      });

      this.copyStream.on('error', (error: Error) => {
        // Don't log errors during intentional shutdown
        if (!this.isShuttingDown) {
          this.log.error('COPY stream error', { viewName }, error);
          throw error;
        }
        this.isStreaming = false;
      });

      this.isStreaming = true;
      this.log.info('Stream subscription started', { viewName });

    } catch (error) {
      this.log.error('Failed to start streaming', { viewName }, error as Error);
      throw new Error(`Stream initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Stop streaming
   */
  async stopStreaming(): Promise<void> {
    this.isStreaming = false;
    this.isShuttingDown = true;
    
    if (this.copyStream) {
      try {
        this.log.debug('Closing COPY stream');
        this.copyStream.destroy();
        this.copyStream = null;
      } catch (error) {
        this.log.debug('Error closing COPY stream (may already be closed)', {}, error as Error);
      }
    }
    
    this.log.info('Stream stopped');
  }

  /**
   * Get streaming status
   */
  get streaming(): boolean {
    return this.isStreaming;
  }
}