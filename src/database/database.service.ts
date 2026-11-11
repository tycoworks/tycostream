import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { Selection, StreamMode } from '../common/types.js';
import { Statement } from './statement.js';
import { DatabaseStream } from './stream.js';
import { DatabaseAdapter } from './types.js';
import type { RowUpdateBatches } from './types.js';

/**
 * The database layer's one export: streams on sources, in either mode,
 * through the adapter. Opens one DatabaseStream per stream, and closes any
 * still open first thing at shutdown.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly open = new Set<RowUpdateBatches>();

  constructor(
    private readonly connectionService: DatabaseConnectionService,
    private readonly adapter: DatabaseAdapter,
  ) {}

  /**
   * A stream on the source's rows the selection selects: the snapshot, then,
   * if live, every change. Throws if the selection is invalid; ending the
   * iteration closes the stream.
   */
  stream(
    source: SourceDefinition,
    selection: Selection,
    mode: StreamMode,
  ): RowUpdateBatches {
    const stream = new DatabaseStream(
      this.connectionService,
      this.adapter,
      new Statement(source, selection, mode),
    );
    const batches = stream.read({
      onOpen: () => this.open.add(batches),
      onClose: () => this.open.delete(batches),
    });
    return batches;
  }

  /**
   * Closes the open streams first thing at shutdown, so their SSE responses
   * finish and the HTTP server can close
   */
  async onModuleDestroy() {
    this.logger.log(`Closing ${this.open.size} database streams`);
    await Promise.all([...this.open].map((batches) => batches.return()));
    this.open.clear();
  }
}
