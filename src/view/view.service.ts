import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import type { RowUpdateBatches } from '../database/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { StreamMode } from '../common/types.js';
import type { WhereClause } from '../common/types.js';

/**
 * ViewService manages views of streaming data
 * This is the main interface for GraphQL subscriptions. For now each view
 * passes straight through to its own database subscription; a shared cache
 * would go here.
 */
@Injectable()
export class ViewService {
  constructor(private readonly databaseService: DatabaseService) {}

  /**
   * A view of a source's rows that match the filter: its row events, one
   * complete timestamp at a time, the snapshot first. Ending the iteration
   * closes the view.
   */
  subscribe(source: SourceDefinition, where?: WhereClause): RowUpdateBatches {
    return this.databaseService.stream(source, where, StreamMode.Live);
  }
}
