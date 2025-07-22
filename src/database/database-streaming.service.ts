import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import { to as copyTo } from 'pg-copy-streams';
import type { Client } from 'pg';
import { DatabaseConnectionService } from './database-connection.service';
import { StreamBuffer } from './stream-buffer';
import { SimpleCache } from './cache';
import type { Cache } from './cache.types';
import type { ProtocolHandler } from './types';
import type { SourceDefinition } from '../config/source-definition.types';
import { RowUpdateType, type RowUpdateEvent } from './types';

/**
 * Database streaming service for a single source
 * Handles streaming subscription from a Materialize view
 * 
 * TODO: This is currently a basic implementation for Phase 3.
 * Phase 4 will enhance this with proper Observable-based streaming and late joiner support.
 */
@Injectable()
export class DatabaseStreamingService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamingService.name);
  private readonly cache: Cache;
  private readonly buffer = new StreamBuffer();
  private readonly updates$ = new Subject<RowUpdateEvent>();
  private client: Client | null = null;
  private isShuttingDown = false;
  private isStreaming = false;
  private latestTimestamp = BigInt(0);

  constructor(
    private connectionService: DatabaseConnectionService,
    private readonly sourceDef: SourceDefinition,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler
  ) {
    // Create internal simple cache
    this.cache = new SimpleCache(sourceDef.primaryKeyField);
  }

  /**
   * Get a stream of updates
   * This is the main interface that will be used by GraphQL subscriptions
   * 
   * TODO: Phase 4 will implement late joiner support by replaying cache state
   */
  getUpdates(): Observable<RowUpdateEvent> {
    if (!this.isStreaming && !this.isShuttingDown) {
      // Start streaming in background
      this.startStreaming().catch(error => {
        this.logger.error(`Failed to start streaming for ${this.sourceName}`, error);
        this.updates$.error(error);
      });
    }

    // TODO: Phase 4 will implement proper multicasting with late joiner support
    return this.updates$.asObservable();
  }

  /**
   * Get current state snapshot
   */
  getAllRows(): Record<string, any>[] {
    return this.cache.getAllRows();
  }

  /**
   * Get a specific row by primary key
   */
  getRow(primaryKey: string | number): Record<string, any> | undefined {
    return this.cache.get(primaryKey);
  }

  /**
   * Get cache size
   */
  getCacheSize(): number {
    return this.cache.size;
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
    this.logger.log('Shutting down stream...');
    this.isShuttingDown = true;
    
    if (this.isStreaming && this.client) {
      try {
        await this.connectionService.disconnect(this.client);
      } catch (error) {
        this.logger.error('Error disconnecting client', error);
      }
    }
    
    this.updates$.complete();
  }

  /**
   * Internal method to start streaming
   */
  private async startStreaming(): Promise<void> {
    if (this.isStreaming) {
      this.logger.warn('Stream already active');
      return;
    }

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
          const parsed = this.protocolHandler.parseLine(line);
          
          if (parsed) {
            this.latestTimestamp = parsed.timestamp;
            
            if (parsed.isDelete) {
              this.cache.delete(parsed.row);
              this.updates$.next({
                type: RowUpdateType.Delete,
                row: parsed.row
              });
            } else {
              const isUpdate = this.cache.has(parsed.row[this.sourceDef.primaryKeyField]);
              this.cache.set(parsed.row);
              this.updates$.next({
                type: isUpdate ? RowUpdateType.Update : RowUpdateType.Insert,
                row: parsed.row
              });
            }
          }
        }
      });

      copyStream.on('error', (error) => {
        this.logger.error('Stream error:', error);
        this.isStreaming = false;
        this.updates$.error(error);
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
}