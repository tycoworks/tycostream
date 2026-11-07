import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { DatabaseConfig } from '../config/database.config.js';

const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

// Every value arrives as text; tycostream types it as schema.yaml says
const TEXT_ONLY = { getTypeParser: () => (value: string) => value };

/**
 * What a connection is for, which decides where it comes from and its limits
 */
export enum ConnectionType {
  // A connection of its own, for as long as the subscriber stays
  Subscription,
}

/**
 * A connection lent to one caller. close() when finished with it, or let
 * `await using` do it; aborting the signal given to acquire() cancels it.
 */
export interface Lease extends AsyncDisposable {
  readonly client: pg.ClientBase;
  close(): Promise<void>;
}

/**
 * The one place tycostream makes database connections. Callers say what a
 * connection is for, and get a lease on one with that type's limits.
 */
@Injectable()
export class DatabaseConnectionService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DatabaseConnectionService.name);
  private lending = true;
  private config!: DatabaseConfig;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const config = this.configService.get<DatabaseConfig>('database');
    if (!config) {
      throw new Error('Database configuration not found');
    }
    this.config = config;
    this.logger.log(
      `Database: ${config.user}@${config.host}:${config.port}/${config.database}`,
    );
  }

  /**
   * Lends a connected connection of the type. Aborting the signal, at
   * any point, ends the connection at once, even while it's connecting or
   * mid-statement; while connecting, acquire() then rejects.
   */
  async acquire(type: ConnectionType, signal?: AbortSignal): Promise<Lease> {
    if (!this.lending) {
      throw new Error("tycostream is shutting down; it's not connecting");
    }
    signal?.throwIfAborted();
    switch (type) {
      case ConnectionType.Subscription:
        return this.connectOwn(signal);
    }
  }

  /**
   * Stops lending at the start of shutdown, so a subscription arriving after
   * the open ones have closed fails, instead of holding the HTTP server open
   */
  onModuleDestroy() {
    this.lending = false;
  }

  private async connectOwn(signal?: AbortSignal): Promise<Lease> {
    const client = new pg.Client({
      ...this.sharedSettings(),
      query_timeout: 0, // A subscription's reads have no time limit
    });
    // A connection that fails while lent mustn't crash the process; its
    // holder hears of it from its own listener or its next statement
    client.on('error', (error) =>
      this.logger.debug(`Connection error: ${error.message}`),
    );

    let ending: Promise<void> | undefined;
    const end = () => (ending ??= client.end().catch(() => {}));
    // Cancelling ends the connection, and stops waiting for it to connect:
    // a connection ended while it's connecting never settles its connect()
    const cancelled = new Promise<never>((_, reject) => {
      signal?.addEventListener(
        'abort',
        () => {
          void end();
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
    // Once connected, a cancel only ends the connection; nothing waits on this
    cancelled.catch(() => {});

    try {
      await Promise.race([client.connect(), cancelled]);
    } catch (error) {
      await end();
      throw error;
    }
    return { client, close: end, [Symbol.asyncDispose]: end };
  }

  private sharedSettings(): pg.ClientConfig {
    return {
      host: this.config.host,
      port: this.config.port,
      database: this.config.database,
      user: this.config.user,
      password: this.config.password,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: DB_KEEP_ALIVE_DELAY_MS,
      types: TEXT_ONLY,
    };
  }
}
