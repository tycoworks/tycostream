import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { WhereClause } from '../common/types.js';
import { buildSelect } from './query.js';
import { DatabaseStream } from './stream.js';
import { DatabaseDriver } from './types.js';
import type { RowUpdateBatches } from './types.js';

/**
 * The database layer's one export: subscriptions to sources, through the
 * driver. Opens one DatabaseStream per subscription, and closes any still
 * open first thing at shutdown.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  private readonly open = new Set<RowUpdateBatches>();

  constructor(
    private readonly connectionService: DatabaseConnectionService,
    private readonly driver: DatabaseDriver,
  ) {}

  /**
   * Subscribes to a source's rows that match the filter. Throws if the
   * filter is invalid; ending the iteration closes the subscription.
   */
  subscribe(source: SourceDefinition, where?: WhereClause): RowUpdateBatches {
    const stream = new DatabaseStream(
      this.connectionService,
      source,
      this.driver.subscriptions,
      buildSelect(source, where),
    );
    const batches = stream.read({
      onOpen: () => this.open.add(batches),
      onClose: () => this.open.delete(batches),
    });
    return batches;
  }

  /**
   * Closes the open subscriptions first thing at shutdown, so their SSE
   * responses finish and the HTTP server can close
   */
  async onModuleDestroy() {
    this.logger.log(`Closing ${this.open.size} database streams`);
    await Promise.all([...this.open].map((changes) => changes.return()));
    this.open.clear();
  }
}
