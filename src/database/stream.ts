import { Logger } from '@nestjs/common';
import { Repeater } from '@repeaterjs/repeater';
import { ConnectionType } from './connection.service.js';
import type { DatabaseConnectionService } from './connection.service.js';
import type { CompiledQuery } from './query.js';
import type { RowUpdateEvent } from '../common/types.js';
import type { ChangeBatches, ProtocolHandler } from './types.js';

/**
 * Called when a stream starts, on the first pull, and once it has closed.
 * A stream that's never pulled opens nothing.
 */
export interface StreamLifecycle {
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * One subscription on a connection of its own. The protocol handler does
 * all the talking over it; this holds the connection for as long as the
 * subscriber stays, and hands on what the handler reads.
 */
export class DatabaseStream {
  private readonly logger = new Logger(DatabaseStream.name);

  constructor(
    private readonly connectionService: DatabaseConnectionService,
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
  read(lifecycle: StreamLifecycle = {}): ChangeBatches {
    return new Repeater<RowUpdateEvent[]>(async (push, stop) => {
      // Stopping cancels the connection, which ends the subscription in the
      // database at once, even mid-read or while still connecting
      const cancel = new AbortController();
      let stopped = false;
      void stop.then(() => {
        stopped = true;
        cancel.abort();
      });
      lifecycle.onOpen?.();

      const readUntilStopped = async () => {
        await using lease = await this.connectionService.acquire(
          ConnectionType.Subscription,
          cancel.signal,
        );
        lease.client.on('error', (error) => void stop(error));
        this.logger.debug(`Subscribing to ${this.sourceName}`);
        for await (const batch of this.protocolHandler.read(
          lease.client,
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

      const reading = readUntilStopped().catch((error: unknown) => {
        if (!stopped) {
          void stop(error);
        }
      });

      await stop;
      // Returns once the connection is closed
      await reading;
      this.logger.debug(`Closed the subscription to ${this.sourceName}`);
      lifecycle.onClose?.();
    });
  }
}
