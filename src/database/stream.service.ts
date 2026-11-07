import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { WhereClause } from '../common/types.js';
import { MaterializeProtocolHandler } from './materialize.js';
import { buildSelect } from './query.js';
import { DatabaseStream } from './stream.js';
import type { ChangeBatches } from './types.js';

/**
 * Database stream management service
 * Opens one DatabaseStream per subscription, and closes any still open on
 * shutdown
 */
@Injectable()
export class DatabaseStreamService implements OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamService.name);
  private readonly open = new Set<ChangeBatches>();

  constructor(private readonly connectionService: DatabaseConnectionService) {}

  /**
   * Subscribes to a source's rows that match the filter. Throws if the
   * filter is invalid; ending the iteration closes the subscription.
   */
  subscribe(source: SourceDefinition, where?: WhereClause): ChangeBatches {
    const stream = new DatabaseStream(
      this.connectionService,
      source.name,
      new MaterializeProtocolHandler(source),
      buildSelect(source, where),
    );
    const changes = stream.read({
      onOpen: () => this.open.add(changes),
      onClose: () => this.open.delete(changes),
    });
    return changes;
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
