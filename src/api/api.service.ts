import { Injectable, Logger } from '@nestjs/common';
import { Repeater } from '@repeaterjs/repeater';
import { ViewService } from '../view/view.service.js';
import { RowUpdateType, StreamMode } from '../common/types.js';
import type { Row, RowUpdateEvent, Selection } from '../common/types.js';
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

/**
 * The API layer's one service: GraphQL's operations on a source, each a
 * stream on a view of it
 */
@Injectable()
export class ApiService {
  private readonly logger = new Logger(ApiService.name);

  constructor(private readonly viewService: ViewService) {}

  /**
   * A GraphQL query: a snapshot stream on the view, its rows returned once,
   * in the selection's order. Throws if the selection is invalid; a database
   * error, or the time limit,
   * fails the query. Aborting the signal, as the client leaving does, stops
   * the stream, which ends the query in the database.
   */
  async query(
    source: SourceDefinition,
    selection: Selection = {},
    signal?: AbortSignal,
  ): Promise<Row[]> {
    this.logger.log(`Query for ${describe(source, selection)}`);

    const batches = this.viewService.stream(
      source,
      selection,
      StreamMode.Snapshot,
    );
    const stop = () => void batches.return();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      const rows: Row[] = [];
      for await (const { events } of batches) {
        rows.push(...events.map((event) => event.row));
      }
      // A stopped stream just ends, so say why it stopped
      signal?.throwIfAborted();
      return rows;
    } finally {
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * A GraphQL subscription: a live stream on the view, each timestamp's row
   * events sent as one list of GraphQL updates, the snapshot first, even
   * when it's empty. The selection's limit and offset choose the rows it
   * covers, so a row leaving them arrives as a delete. Throws if the
   * selection is invalid; a database error ends the subscription with that
   * error.
   */
  subscribe(
    source: SourceDefinition,
    selection: Selection = {},
  ): AsyncIterableIterator<GraphQLUpdate[]> {
    this.logger.log(`Subscription for ${describe(source, selection)}`);

    const batches = this.viewService.stream(source, selection, StreamMode.Live);

    return new Repeater<GraphQLUpdate[]>(async (push, stop) => {
      const forward = async () => {
        for await (const { timestamp, events } of batches) {
          const updates = events.map((event) =>
            this.transformToGraphQLUpdate(event),
          );
          this.logger.debug(
            `Sending GraphQL updates - source: ${source.name}, timestamp: ${timestamp}, ` +
              `updates: ${truncateForLog(updates)}`,
          );
          await push(updates);
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

// A source and its selection, for the logs
function describe(source: SourceDefinition, selection: Selection): string {
  const selected = Object.values(selection).some(
    (value) => value !== undefined,
  );
  return `${source.name}${selected ? ` with selection: ${truncateForLog(selection)}` : ' (everything)'}`;
}
