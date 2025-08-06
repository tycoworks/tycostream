import { Logger, OnModuleDestroy } from '@nestjs/common';
import { to as copyTo } from 'pg-copy-streams';
import type { Client } from 'pg';
import { DatabaseConnectionService } from './connection.service';
import { StreamBuffer } from './buffer';
import type { ProtocolHandler } from './types';
import { DatabaseRowUpdateType } from './types';

/**
 * Manages database subscription and streaming for a single source
 * Delegates to parent service for update processing
 */
export class DatabaseSubscriber implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseSubscriber.name);
  private readonly buffer = new StreamBuffer();
  private client: Client | null = null;
  private isShuttingDown = false;
  private connected = false;
  private updateCallback?: (row: Record<string, any>, timestamp: bigint, updateType: DatabaseRowUpdateType) => void;
  private errorCallback?: (error: Error) => void;

  constructor(
    private connectionService: DatabaseConnectionService,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {}

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

    // Connect to database
    this.client = await this.connectionService.connect();

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
        this.logger.error('Stream error');
        this.connected = false;
        
        // Notify parent of runtime error
        if (this.errorCallback) {
          this.errorCallback(error);
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
        await this.connectionService.disconnect(this.client);
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
   * End the connection and clean up resources
   * Follows pg client naming convention
   */
  end(): void {
    this.logger.debug(`Ending connection for ${this.sourceName}`);
    this.isShuttingDown = true;
    
    if (this.connected && this.client) {
      // Disconnect asynchronously without waiting
      this.connectionService.disconnect(this.client).catch(error => {
        this.logger.error('Error disconnecting client during end', error);
      });
      this.connected = false;
      this.client = null;
    }
  }

  /**
   * Cleanup on module destroy
   * Delegates to end() for cleanup
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down database subscriber...');
    this.end();
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