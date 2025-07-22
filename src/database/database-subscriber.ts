import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { to as copyTo } from 'pg-copy-streams';
import type { Client } from 'pg';
import { DatabaseConnectionService } from './database-connection.service';
import { StreamBuffer } from './stream-buffer';
import type { ProtocolHandler } from './types';

/**
 * Manages database subscription and streaming for a single source
 * Delegates to parent service for update processing
 */
@Injectable()
export class DatabaseSubscriber implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseSubscriber.name);
  private readonly buffer = new StreamBuffer();
  private client: Client | null = null;
  private isShuttingDown = false;
  private isStreaming = false;
  private updateCallback?: (row: Record<string, any>, timestamp: bigint, isDelete: boolean) => void;
  private errorCallback?: (error: Error) => void;

  constructor(
    private connectionService: DatabaseConnectionService,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {}

  /**
   * Start streaming with callback for updates and errors
   */
  async startStreaming(
    onUpdate: (row: Record<string, any>, timestamp: bigint, isDelete: boolean) => void,
    onError?: (error: Error) => void
  ): Promise<void> {
    if (this.isStreaming) {
      this.logger.warn('Stream already active');
      return;
    }

    this.updateCallback = onUpdate;
    this.errorCallback = onError;
    this.isStreaming = true;
    this.logger.log(`Starting stream for source: ${this.sourceName}`);

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
        this.logger.error('Stream error:', error);
        this.isStreaming = false;
        // Notify parent of runtime error
        if (this.errorCallback) {
          this.errorCallback(error);
        }
      });

      copyStream.on('end', () => {
        // Only warn about unexpected stream end
        if (!this.isShuttingDown) {
          this.logger.warn('COPY stream ended', { sourceName: this.sourceName });
        }
        this.isStreaming = false;
      });
    } catch (error) {
      this.isStreaming = false;
      if (this.client) {
        await this.connectionService.disconnect(this.client);
      }
      throw error;
    }
  }

  /**
   * Check if streaming is active
   */
  get streaming(): boolean {
    return this.isStreaming;
  }

  /**
   * Cleanup on module destroy
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down database subscriber...');
    this.isShuttingDown = true;
    
    if (this.isStreaming && this.client) {
      try {
        await this.connectionService.disconnect(this.client);
      } catch (error) {
        this.logger.error('Error disconnecting client', error);
      }
    }
  }

  private processLine(line: string): void {
    const parsed = this.protocolHandler.parseLine(line);
    
    if (parsed && this.updateCallback) {
      // Send raw update to parent service - parent will determine insert vs update
      this.updateCallback(parsed.row, parsed.timestamp, parsed.isDelete);
    }
  }
}