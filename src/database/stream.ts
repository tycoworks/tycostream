import { Logger, OnModuleDestroy } from '@nestjs/common';
import { to as copyTo } from 'pg-copy-streams';
import { Client } from 'pg';
import { StreamBuffer } from './buffer';
import type { ProtocolHandler } from './types';
import { DatabaseRowUpdateType } from './types';
import type { DatabaseConfig } from '../config/database.config';

/**
 * Represents a streaming connection to a database source
 * Handles the COPY protocol and event streaming
 */
// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

export class DatabaseStream {
  private readonly logger = new Logger(DatabaseStream.name);
  private readonly buffer = new StreamBuffer();
  private client: Client | null = null;
  private isShuttingDown = false;
  private connected = false;
  private updateCallback?: (row: Record<string, any>, timestamp: bigint, updateType: DatabaseRowUpdateType) => void;
  private errorCallback?: (error: Error) => void;

  constructor(
    private readonly config: DatabaseConfig,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {}

  /**
   * Check if this stream has been disconnected
   */
  get isDisposed(): boolean {
    return this.isShuttingDown;
  }

  /**
   * Connect to database and begin COPY stream for continuous updates
   * Follows pg client naming convention
   */
  async connect(
    onUpdate: (row: Record<string, any>, timestamp: bigint, updateType: DatabaseRowUpdateType) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    if (this.connected) {
      this.logger.warn('Already connected');
      return;
    }

    this.updateCallback = onUpdate;
    this.errorCallback = onError;
    this.connected = true;
    this.logger.log(`Connecting to source: ${this.sourceName}`);

    // Create and connect client directly
    this.client = await this.createClient();

    try {
      // Create COPY query that wraps the SUBSCRIBE
      const subscribeQuery = this.protocolHandler.createSubscribeQuery();
      const copyQuery = `COPY (${subscribeQuery}) TO STDOUT`;
      
      this.logger.log(`Executing query: ${copyQuery}`);

      // Start streaming
      const copyStream = this.client.query(copyTo(copyQuery));

      copyStream.on('data', (chunk: Buffer) => {
        if (this.isShuttingDown) return;

        const lines = this.buffer.processChunk(chunk);
        
        for (const line of lines) {
          this.processLine(line);
        }
      });

      copyStream.on('error', (error) => {
        this.connected = false;
        
        // Only treat as error if not shutting down
        if (!this.isShuttingDown) {
          this.logger.error('Stream error');
          // Notify parent of runtime error
          if (this.errorCallback) {
            this.errorCallback(error);
          }
        }
      });

      copyStream.on('end', () => {
        this.connected = false;
        
        // Only warn about unexpected stream end
        if (!this.isShuttingDown) {
          this.logger.warn('COPY stream ended unexpectedly', { sourceName: this.sourceName });
          // Stream end without error usually means database closed connection
          const error = new Error(`Database stream ended unexpectedly for source ${this.sourceName}`);
          if (this.errorCallback) {
            this.errorCallback(error);
          }
        }
      });
    } catch (error) {
      this.connected = false;
      if (this.client) {
        // Close the client directly
        await this.client.end();
        this.client = null;
      }
      throw error;
    }
  }

  /**
   * Check if streaming is active (backward compatibility)
   */
  get streaming(): boolean {
    return this.connected;
  }

  /**
   * Disconnect and clean up resources
   * Connection-like objects use connect/disconnect pattern
   */
  disconnect(): void {
    this.logger.debug(`Ending connection for ${this.sourceName}`);
    this.isShuttingDown = true;
    
    if (this.connected && this.client) {
      // Close the client directly
      this.client.end().catch(error => {
        this.logger.error('Error closing client during disconnect', error);
      });
      this.connected = false;
      this.client = null;
    }
  }


  /**
   * Create a new database client
   * Returns a connected client with streaming-optimized settings
   */
  private async createClient(): Promise<Client> {
    if (!this.config) {
      throw new Error('Database configuration not found');
    }

    this.logger.log(`Creating database client for ${this.sourceName}`);

    const client = new Client({
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

    try {
      await client.connect();
      this.logger.log('Connected to streaming database');
      return client;
    } catch (error) {
      this.logger.error('Failed to connect to streaming database');
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Database connection failed: ${errorMessage}`);
    }
  }

  /**
   * Process a single line from the COPY stream
   * Parses the line and forwards to update callback if valid
   */
  private processLine(line: string): void {
    const parsed = this.protocolHandler.parseLine(line);
    
    if (parsed && this.updateCallback) {
      // Send raw update to parent service - parent will determine insert vs update
      this.updateCallback(parsed.row, parsed.timestamp, parsed.updateType);
    }
  }
}