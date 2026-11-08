import { Injectable, Logger } from '@nestjs/common';
import { Repeater } from '@repeaterjs/repeater';
import { ViewService } from '../view/view.service.js';
import { RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateEvent, WhereClause } from '../common/types.js';
import { truncateForLog } from '../common/logging.utils.js';
import type { SourceDefinition } from '../config/source.types.js';

/**
 * GraphQL row operation types
 * These map to the values used in the GraphQL schema
 */
export enum GraphQLRowOperation {
  Insert = 'INSERT',
  Update = 'UPDATE',
  Delete = 'DELETE',
}

/**
 * GraphQL subscription update structure
 */
export interface GraphQLUpdate {
  operation: GraphQLRowOperation;
  data: Row;
  fields: string[];
}

/**
 * Maps RowUpdateType enum values to GraphQL operation enum values
 */
const ROW_UPDATE_TYPE_MAP = {
  [RowUpdateType.Insert]: GraphQLRowOperation.Insert,
  [RowUpdateType.Update]: GraphQLRowOperation.Update,
  [RowUpdateType.Delete]: GraphQLRowOperation.Delete,
} as const;

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(private readonly viewService: ViewService) {}

  /**
   * Creates a subscription stream for a data source
   * Transforms row events into GraphQL updates. Throws if the filter is
   * invalid; a database error ends this subscription with that error.
   */
  subscribe(
    source: SourceDefinition,
    where?: WhereClause,
  ): AsyncIterableIterator<GraphQLUpdate> {
    this.logger.log(
      `Subscription for ${source.name}${where ? ` with filter: ${truncateForLog(where)}` : ' (unfiltered)'}`,
    );

    const batches = this.viewService.subscribe(source, where);

    return new Repeater<GraphQLUpdate>(async (push, stop) => {
      const forward = async () => {
        for await (const events of batches) {
          for (const event of events) {
            const update = this.transformToGraphQLUpdate(event);
            this.logger.debug(
              `Sending GraphQL update - source: ${source.name}, operation: ${update.operation}, ` +
                `data: ${truncateForLog(update.data)}, fields: [${update.fields.join(', ')}]`,
            );
            await push(update);
          }
        }
        // The view ended by itself
        void stop();
      };
      forward().catch((error: unknown) => void stop(error));

      await stop;
      // Closes the view at once, even on a view that's idle. If the view
      // failed, forward already reported its error.
      await batches.return().catch(() => {});
    });
  }

  /**
   * Transforms a row event into a GraphQL update
   * Sends only the event's fields: the whole row for an insert, the key and
   * the changed fields for an update, and the key alone for a delete
   */
  private transformToGraphQLUpdate(event: RowUpdateEvent): GraphQLUpdate {
    const operation = ROW_UPDATE_TYPE_MAP[event.type];

    // Convert Set to array for GraphQL
    const fields = Array.from(event.fields);
    const data = Object.fromEntries(
      fields.map((field) => [field, event.row[field]]),
    );

    return { operation, data, fields };
  }
}
