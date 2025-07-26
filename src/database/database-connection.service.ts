import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import type { DatabaseConfig } from '../config/database.config';

// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

/**
 * Database connection management service
 * Handles PostgreSQL client connections for streaming operations
 */
@Injectable()
export class DatabaseConnectionService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseConnectionService.name);
  private clients: Set<Client> = new Set();

  constructor(private configService: ConfigService) {}

  /**
   * Connect to streaming database
   * Creates a new client connection with streaming-optimized settings
   */
  async connect(): Promise<Client> {
    const config = this.configService.get<DatabaseConfig>('database');
    
    if (!config) {
      throw new Error('Database configuration not found');
    }

    this.logger.log(`Connecting to streaming database at ${config.host}:${config.port}/${config.database}`);

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
      this.clients.add(client);
      this.logger.log('Connected to streaming database');
      return client;
    } catch (error) {
      this.logger.error('Failed to connect to streaming database');
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Database connection failed: ${errorMessage}`);
    }
  }

  /**
   * Disconnect a specific client
   */
  async disconnect(client: Client): Promise<void> {
    try {
      await client.end();
      this.clients.delete(client);
      this.logger.log('Database connection closed');
    } catch (error) {
      this.logger.error('Error during disconnect');
      // Still remove from set even if disconnect fails
      this.clients.delete(client);
      throw error;
    }
  }

  /**
   * Cleanup all connections on module destroy
   */
  async onModuleDestroy() {
    this.logger.log(`Closing ${this.clients.size} database connections`);
    
    const disconnectPromises = Array.from(this.clients).map(client =>
      this.disconnect(client).catch(error => 
        this.logger.error('Error closing connection during shutdown')
      )
    );
    
    await Promise.all(disconnectPromises);
  }
}