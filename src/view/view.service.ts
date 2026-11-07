import { Injectable, Logger } from '@nestjs/common';
import { DatabaseStreamService } from '../database/stream.service.js';
import type { ChangeBatches } from '../database/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { WhereClause } from '../common/types.js';
import { truncateForLog } from '../common/logging.utils.js';

/**
 * ViewService manages views of streaming data
 * This is the main interface for GraphQL subscriptions. For now each view
 * passes straight through to its own database subscription; a shared cache
 * would go here.
 */
@Injectable()
export class ViewService {
  private readonly logger = new Logger(ViewService.name);

  constructor(private readonly streamService: DatabaseStreamService) {}

  /**
   * A view of a source's rows that match the filter: its row events, one
   * complete timestamp at a time, the snapshot first. Ending the iteration
   * closes the view.
   */
  subscribe(source: SourceDefinition, where?: WhereClause): ChangeBatches {
    this.logger.debug(
      `Created new view for source: ${source.name}${where ? `, where: ${truncateForLog(where)}` : ' (unfiltered)'}`,
    );
    return this.streamService.subscribe(source, where);
  }
}
