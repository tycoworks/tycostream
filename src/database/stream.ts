import { Logger } from '@nestjs/common';
import { Repeater } from '@repeaterjs/repeater';
import pg from 'pg';
import type { DatabaseConfig } from '../config/database.config.js';
import type { CompiledQuery } from './query.js';
import type { RowUpdateEvent } from '../common/types.js';
import type { ChangeBatches, ProtocolHandler } from './types.js';

// Component-specific database configuration
const DB_CONNECTION_TIMEOUT_MS = 10000; // Allow sufficient time for network latency
const DB_KEEP_ALIVE_DELAY_MS = 10000; // Prevent connection drops

/**
 * One subscription on its own connection. The protocol handler does all the
 * talking over it; this owns the connection and hands on what it reads.
 */
export class DatabaseStream {
  private readonly logger = new Logger(DatabaseStream.name);

  constructor(
    private readonly config: DatabaseConfig,
    private readonly sourceName: string,
    private readonly protocolHandler: ProtocolHandler,
    private readonly query: CompiledQuery,
  ) {}

  /**
   * The subscription's row events, one complete timestamp at a time, the
   * snapshot first. The connection opens on the first pull.
   *
   * The handler reads on only once the consumer has taken the last batch,
   * so a slow consumer's rows queue in the database. Ending the iteration
   * closes the connection, which ends the subscription in the database.
   */
  read(onClosed: () => void = () => {}): ChangeBatches {
    return new Repeater<RowUpdateEvent[]>(async (push, stop) => {
      const client = this.createClient();
      client.on('error', (error) => void stop(error));
      let stopped = false;

      const readUntilStopped = async () => {
        await client.connect();
        this.logger.debug(`Subscribing to ${this.sourceName}`);
        for await (const batch of this.protocolHandler.read(
          client,
          this.query,
        )) {
          await push(batch);
          if (stopped) {
            return;
          }
        }
        // The handler finished by itself, so the subscription is over
        void stop();
      };

      readUntilStopped().catch((error: unknown) => {
        if (!stopped) {
          void stop(error);
        }
      });

      await stop;
      stopped = true;
      // Ending the connection ends the subscription at once, mid-read or not
      await client.end().catch(() => {});
      this.logger.debug(`Closed the subscription to ${this.sourceName}`);
      onClosed();
    });
  }

  private createClient(): pg.Client {
    return new pg.Client({
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
  }
}
