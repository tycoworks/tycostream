import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseConfig } from '../config/database.config.js';
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
export class DatabaseStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamService.name);
  private readonly open = new Set<ChangeBatches>();
  private dbConfig!: DatabaseConfig;

  constructor(private configService: ConfigService) {}

  /**
   * Initialize and log database configuration
   */
  async onModuleInit() {
    const config = this.configService.get<DatabaseConfig>('database');
    if (!config) {
      throw new Error('Database configuration not found');
    }
    this.dbConfig = config;
    this.logger.log(
      `Database: ${this.dbConfig.user}@${this.dbConfig.host}:${this.dbConfig.port}/${this.dbConfig.database}`,
    );
  }

  /**
   * Subscribes to a source's rows that match the filter. Throws if the
   * filter is invalid; ending the iteration closes the subscription.
   */
  subscribe(source: SourceDefinition, where?: WhereClause): ChangeBatches {
    const stream = new DatabaseStream(
      this.dbConfig,
      source.name,
      new MaterializeProtocolHandler(source),
      buildSelect(source, where),
    );
    const changes = stream.read(() => this.open.delete(changes));
    this.open.add(changes);
    return changes;
  }

  /**
   * Cleanup all connections on module destroy
   */
  async onModuleDestroy() {
    this.logger.log(`Closing ${this.open.size} database streams`);
    await Promise.all([...this.open].map((changes) => changes.return()));
    this.open.clear();
  }
}
