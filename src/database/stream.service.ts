import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseConfig } from '../config/database.config';
import { DatabaseStream } from './stream';
import type { ProtocolHandler } from './types';

/**
 * Database stream management service
 * Manages DatabaseStream instances and their underlying connections
 */
@Injectable()
export class DatabaseStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamService.name);
  private streams = new Map<string, DatabaseStream>();
  private dbConfig!: DatabaseConfig;

  constructor(private configService: ConfigService) {}

  /**
   * Initialize and log database configuration
   */
  async onModuleInit() {
    const config = this.configService.get<DatabaseConfig>('database');
    if (!config) {
      throw new Error('Database configuration not found');
    }
    this.dbConfig = config;
    this.logger.log(`Database: ${this.dbConfig.user}@${this.dbConfig.host}:${this.dbConfig.port}/${this.dbConfig.database}`);
  }

  /**
   * Get or create a DatabaseStream for a specific source
   * Manages the lifecycle of database streams
   */
  getStream(sourceName: string, protocolHandler: ProtocolHandler): DatabaseStream {
    let stream = this.streams.get(sourceName);

    // Check if existing stream is disposed and needs recreation
    if (stream && stream.isDisposed) {
      this.logger.debug(`DatabaseStream ${sourceName} is disposed, creating fresh instance`);
      this.streams.delete(sourceName);
      stream = undefined;
    }

    if (!stream) {
      this.logger.log(`Creating new database stream for source: ${sourceName}`);
      stream = new DatabaseStream(this.dbConfig, sourceName, protocolHandler);
      this.streams.set(sourceName, stream);
    }
    return stream;
  }

  /**
   * Remove a stream when it's no longer needed
   * Called by SourceService when disposing a Source
   */
  removeStream(sourceName: string): void {
    const stream = this.streams.get(sourceName);
    if (stream) {
      this.logger.log(`Removing database stream for source: ${sourceName}`);
      stream.disconnect();
      this.streams.delete(sourceName);
    }
  }

  /**
   * Cleanup all connections on module destroy
   */
  async onModuleDestroy() {
    this.logger.log(`Closing ${this.streams.size} database streams`);
    
    // Disconnect all streams
    for (const [sourceName, stream] of this.streams) {
      this.logger.debug(`Disconnecting stream for ${sourceName}`);
      stream.disconnect();
    }
    this.streams.clear();
  }
}