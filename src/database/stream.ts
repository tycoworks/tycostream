import { Logger } from '@nestjs/common';
import { Repeater } from '@repeaterjs/repeater';
import type { DatabaseConnectionService } from './connection.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { CompiledSelect } from './select.js';
import { StreamMode } from '../common/types.js';
import type { RowUpdateEvent } from '../common/types.js';
import type { DatabaseAdapter, RowUpdateBatches } from './types.js';

/**
 * Called when a stream starts, on the first pull, and once it has closed.
 * A stream that's never pulled opens nothing.
 */
export interface StreamLifecycle {
  onOpen?: () => void;
  onClose?: () => void;
}

/**
 * One stream on a source, in either mode. The adapter does all the talking
 * over the connection; this borrows it for as long as the stream runs, and
 * hands on what the adapter reads.
 */
export class DatabaseStream {
  private readonly logger = new Logger(DatabaseStream.name);

  constructor(
    private readonly connectionService: DatabaseConnectionService,
    private readonly source: SourceDefinition,
    private readonly mode: StreamMode,
    private readonly adapter: DatabaseAdapter,
    private readonly select: CompiledSelect,
  ) {}

  /**
   * The stream's row events, one complete timestamp at a time, the snapshot
   * first. A snapshot then ends; a live stream goes on until it's stopped.
   * Nothing connects until the first pull.
   *
   * The adapter reads on only once the consumer has taken the last batch,
   * so a slow consumer's rows queue in the database. Ending the iteration
   * cancels the connection, which ends the stream in the database.
   */
  read(lifecycle: StreamLifecycle = {}): RowUpdateBatches {
    return new Repeater<RowUpdateEvent[]>(async (push, stop) => {
      // Stopping cancels the connection, which ends the stream in the
      // database at once, even mid-read or while still connecting
      const cancel = new AbortController();
      let stopped = false;
      void stop.then(() => {
        stopped = true;
        cancel.abort();
      });
      lifecycle.onOpen?.();

      const readUntilStopped = async () => {
        const lease = await this.connectionService.acquire(
          this.mode,
          cancel.signal,
        );
        const onError = (error: Error) => void stop(error);
        lease.client.on('error', onError);
        let failure: unknown;
        try {
          this.logger.debug(
            `Streaming ${this.source.name} (${StreamMode[this.mode]})`,
          );
          for await (const batch of this.adapter.read(
            lease.client,
            this.source,
            this.select,
            this.mode,
          )) {
            await push(batch);
            if (stopped) {
              return;
            }
          }
        } catch (error) {
          // A cancelled stream fails with why it was cancelled, a timeout
          // say, rather than with its connection being ended
          failure = lease.signal.aborted ? lease.signal.reason : error;
          throw failure;
        } finally {
          // A reused connection mustn't keep this stream's listener
          lease.client.removeListener('error', onError);
          await lease.close(failure);
        }
        // The adapter finished reading by itself, as a snapshot does
        void stop();
      };

      const reading = readUntilStopped().catch((error: unknown) => {
        if (!stopped) {
          void stop(error);
        }
      });

      await stop;
      // Returns once the connection is given back
      await reading;
      this.logger.debug(`Closed the stream on ${this.source.name}`);
      lifecycle.onClose?.();
    });
  }
}
