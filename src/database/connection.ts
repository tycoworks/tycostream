import { Client } from 'pg';
import { logger } from '../core/logger.js';
import type { DatabaseConfig } from '../core/config.js';

// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

/**
 * Pure database connection management
 * Internal utility for streaming database adapters
 */
export class DatabaseConnection {
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