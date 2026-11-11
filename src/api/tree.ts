import type { Row, RowUpdateEvent, RowUpdateType } from '../common/types.js';

/**
 * GraphQL's responses, from the events the database layer gives: a query's
 * rows, and a subscription's updates
 */

/**
 * GraphQL subscription update structure
 */
export interface GraphQLUpdate {
  operation: RowUpdateType;
  data: Row;
  fields: string[];
}

/**
 * A query's answer, from its snapshot's events, which are all inserts: each
 * event's row, in the order they came
 */
export function toRows(events: RowUpdateEvent[]): Row[] {
  return events.map((event) => event.row);
}

/**
 * A subscription's message, from one timestamp's events: an update for each
 */
export function toUpdates(events: RowUpdateEvent[]): GraphQLUpdate[] {
  return events.map(updateOf);
}

// An event as a GraphQL update, sending only the event's fields: the whole
// row for an insert, the key and the changed fields for an update, and the
// key alone for a delete
function updateOf(event: RowUpdateEvent): GraphQLUpdate {
  // Convert Set to array for GraphQL
  const fields = Array.from(event.fields);
  const data = Object.fromEntries(
    fields.map((field) => [field, event.row[field]]),
  );

  return { operation: event.type, data, fields };
}
