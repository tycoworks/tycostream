import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';
import type { DatabaseConfig } from '../config/database.config.js';
import { StreamMode } from '../common/types.js';
import { TEXT_ONLY } from './postgres.js';

// Allows for network latency, and also bounds the wait for a free connection
const DB_CONNECTION_TIMEOUT_MS = 10000;
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

/**
 * How a connection is lent to a stream of each mode
 */
interface ModePolicy {
  // Whether a connection given back after its work succeeded is kept for
  // the next borrower, rather than discarded
  reuse: boolean;
  // How long the lease lasts, waiting for a connection included
  timeLimitMs?: number;
}

/**
 * A connection lent to one stream. close() when finished with it, or let
 * `await using` do it; it's cancelled, and discarded at once, when the
 * signal given to acquire() aborts or its mode's time limit runs out.
 */
export interface ConnectionLease extends AsyncDisposable {
  readonly client: pg.ClientBase;
  // Aborted when the lease is cancelled; its reason says why
  readonly signal: AbortSignal;
  /**
   * Gives the connection back. Pass the error if the work failed: the
   * connection is then discarded rather than reused, as pg's own
   * release(error) does, since its query may still be running.
   */
  close(error?: unknown): Promise<void>;
}

/**
 * The one place tycostream makes database connections: one pool, capped,
 * lending to streams of both modes, each under its mode's policy
 */
@Injectable()
export class DatabaseConnectionService
  implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown
{
  private readonly logger = new Logger(DatabaseConnectionService.name);
  private lending = true;
  private pool!: pg.Pool;
  private policies!: Readonly<Record<StreamMode, ModePolicy>>;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const config = this.configService.get<DatabaseConfig>('database');
    if (!config) {
      throw new Error('Database configuration not found');
    }
    this.logger.log(
      `Database: ${config.user}@${config.host}:${config.port}/${config.database}, at most ${config.maxConnections} connections`,
    );
    // Connects nothing until the first stream
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      connectionTimeoutMillis: DB_CONNECTION_TIMEOUT_MS,
      keepAlive: true,
      keepAliveInitialDelayMillis: DB_KEEP_ALIVE_DELAY_MS,
      types: TEXT_ONLY,
      max: config.maxConnections,
    });
    this.pool.on('error', this.logConnectionError);
    this.policies = {
      [StreamMode.Snapshot]: {
        reuse: true,
        timeLimitMs: config.queryTimeoutMs,
      },
      // Ending the connection drops its SUBSCRIBE at once
      [StreamMode.Live]: { reuse: false },
    };
  }

  /**
   * Lends a connection for a stream of the mode, waiting for a free one if
   * every connection is taken. Aborting the signal, or the mode's time limit
   * running out, cancels the lease: the connection is discarded at once,
   * even mid-statement.
   */
  async acquire(
    mode: StreamMode,
    signal?: AbortSignal,
  ): Promise<ConnectionLease> {
    if (!this.lending) {
      throw new Error("tycostream is shutting down; it's not connecting");
    }
    const { reuse, timeLimitMs } = this.policies[mode];
    // The lease is cancelled by the caller, or by its mode's time limit
    const cancellers: AbortSignal[] = [];
    if (signal) {
      cancellers.push(signal);
    }
    if (timeLimitMs !== undefined) {
      cancellers.push(AbortSignal.timeout(timeLimitMs));
    }
    const cancel = AbortSignal.any(cancellers);
    cancel.throwIfAborted();

    // Waiting for a free connection is bounded by the connect timeout
    const client = await this.pool.connect();
    if (cancel.aborted) {
      // Cancelled while waiting: the connection goes back, unused
      client.release();
      throw cancel.reason;
    }
    return new PooledLease(client, cancel, reuse, this.logConnectionError);
  }

  /**
   * Stops lending at the start of shutdown, so a stream arriving after the
   * open ones have closed fails, instead of holding the HTTP server open
   */
  onModuleDestroy() {
    this.lending = false;
  }

  /**
   * Ends the pool last thing at shutdown, once the HTTP server has closed
   */
  async onApplicationShutdown() {
    await this.pool.end();
  }

  // A connection that fails while idle in the pool, or while lent, mustn't
  // crash the process; its holder hears of it from its next statement
  private readonly logConnectionError = (error: Error) =>
    this.logger.debug(`Connection error: ${error.message}`);
}

/**
 * A pooled connection lent to one stream, and given back to the pool once
 */
class PooledLease implements ConnectionLease {
  private released = false;
  private readonly onAbort = () => this.release(true);

  constructor(
    readonly client: pg.PoolClient,
    readonly signal: AbortSignal,
    private readonly reuse: boolean,
    private readonly onError: (error: Error) => void,
  ) {
    client.on('error', onError);
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  close(error?: unknown): Promise<void> {
    this.release(!this.reuse || error !== undefined);
    return Promise.resolve();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  private release(discard: boolean) {
    if (this.released) {
      return;
    }
    this.released = true;
    this.signal.removeEventListener('abort', this.onAbort);
    // Back in the pool, the pool's own listener takes over
    this.client.removeListener('error', this.onError);
    this.client.release(discard);
  }
}
