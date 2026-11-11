import { PATH_SEPARATOR, pathAndKeysOf, pathName } from '../common/types.js';
import type { Row, RowUpdateEvent, RowUpdateType } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';

/**
 * GraphQL's responses, from the flat changes the database layer gives: a
 * query's rows, and a subscription's updates
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
 * A query's answer, from its snapshot's changes, which are all inserts: the
 * selected rows as a tree.
 *
 *   each change's row, its related rows folded into objects   foldRelatedRows
 *   each list's row put in its parent's list, the parent
 *     found by its path and keys                               parentPathOf, listAt
 *   the selected rows, in the order they came
 *
 * A query's changes come in the selection's order, and each list's rows in
 * order under their parent, so each list keeps the order it came in, though
 * a parent can come after its rows. A list with no rows is left out.
 */
export function toRows(
  source: SourceDefinition,
  events: RowUpdateEvent[],
): Row[] {
  const rows = new Map(
    events.map(({ path, keys, row }) => [
      pathAndKeysOf(path, keys),
      foldRelatedRows(row),
    ]),
  );
  const selected: Row[] = [];
  for (const { path, keys } of events) {
    const row = rows.get(pathAndKeysOf(path, keys))!;
    if (path.length === 0) {
      selected.push(row);
    } else {
      const parentPath = parentPathOf(source, path);
      const parent = rows.get(pathAndKeysOf(parentPath, keys.slice(0, -1)))!;
      listAt(parent, path.slice(parentPath.length)).push(row);
    }
  }
  return selected;
}

/**
 * A subscription's message, from one timestamp's events: an update for each
 */
export function toUpdates(events: RowUpdateEvent[]): GraphQLUpdate[] {
  return events.map(updateOf);
}

// An event as a GraphQL update, sending only the event's fields: the whole
// row for an insert, the key and the changed fields for an update, and the
// key alone for a delete. A related row is one field, named when any of its
// columns is, and sent whole.
function updateOf(event: RowUpdateEvent): GraphQLUpdate {
  const row = foldRelatedRows(event.row);
  // A column's field: its own name, or its related row's field
  const fields = [
    ...new Set(
      [...event.fields].map((column) => column.split(PATH_SEPARATOR)[0]),
    ),
  ];
  const data = Object.fromEntries(fields.map((field) => [field, row[field]]));
  return { operation: event.type, data, fields };
}

// A row with each related row's columns, named by its path, folded into an
// object under its field: null when it matched nothing, as all its columns
// are then null, its key among them
function foldRelatedRows(row: Row): Row {
  const folded: Row = {};
  const related = new Map<string, Row>();
  for (const [column, value] of Object.entries(row)) {
    const [field, ...rest] = column.split(PATH_SEPARATOR);
    if (rest.length === 0) {
      folded[column] = value;
    } else {
      const columns = related.get(field) ?? {};
      columns[pathName(rest)] = value;
      related.set(field, columns);
    }
  }
  for (const [field, columns] of related) {
    folded[field] = Object.values(columns).every((value) => value === null)
      ? null
      : foldRelatedRows(columns);
  }
  return folded;
}

// A list's row's parent's path: the row's own, up to the list before the
// row's. A related row on the way is part of its parent's row, so adds no
// key.
function parentPathOf(
  source: SourceDefinition,
  path: readonly string[],
): readonly string[] {
  let from = source;
  let length = 0;
  path.slice(0, -1).forEach((field, index) => {
    const { source: related, many } = from.relationships!.get(field)!;
    if (many) {
      length = index + 1;
    }
    from = related;
  });
  return path.slice(0, length);
}

// The list at a path from a row, through its related rows, made when its
// first row arrives
function listAt(row: Row, path: readonly string[]): Row[] {
  const holder = path
    .slice(0, -1)
    .reduce((related, field) => related[field] as Row, row);
  const field = path.at(-1)!;
  holder[field] ??= [];
  return holder[field] as Row[];
}
