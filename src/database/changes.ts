import { RowUpdateType } from '../common/types.js';
import type { RowUpdateEvent } from '../common/types.js';

/**
 * One row from a SUBSCRIBE, without its timestamp and progress columns:
 * mz_diff, and the row's values
 */
export interface DiffRow {
  diff: number;
  row: Record<string, unknown>;
}

/**
 * Thrown when a timestamp's rows can't be explained by one row per key,
 * so the declared primary key isn't unique
 */
export class KeyViolationError extends Error {
  constructor(primaryKeyField: string, key: unknown) {
    super(
      `More than one row for ${primaryKeyField} = ${String(key)}: the key isn't unique`,
    );
    this.name = 'KeyViolationError';
  }
}

/**
 * Turns the rows of one complete timestamp into insert, update and delete
 * events. Rows can arrive in any order.
 *
 * - Identical rows are netted first: their diffs are summed, and rows that
 *   come to zero are dropped.
 * - Then, per key: a -1 alone is a delete, a +1 alone is an insert, and a -1
 *   with a +1 is an update of the columns that differ. Anything else means
 *   the key isn't unique.
 *
 * An update's and a delete's `fields` follow RowUpdateEvent: the key plus the
 * changed columns, and the key alone.
 */
export function pairChanges(
  rows: DiffRow[],
  primaryKeyField: string,
  fieldNames: string[],
): RowUpdateEvent[] {
  const byKey = new Map<string, DiffRow[]>();
  for (const netted of netIdenticalRows(rows, fieldNames)) {
    const key = valueKey(netted.row[primaryKeyField]);
    const forKey = byKey.get(key) ?? [];
    forKey.push(netted);
    byKey.set(key, forKey);
  }

  return Array.from(byKey.values()).map((forKey) =>
    toEvent(forKey, primaryKeyField, fieldNames),
  );
}

function toEvent(
  forKey: DiffRow[],
  primaryKeyField: string,
  fieldNames: string[],
): RowUpdateEvent {
  const removed = forKey.find((r) => r.diff === -1);
  const added = forKey.find((r) => r.diff === 1);
  const key = forKey[0].row[primaryKeyField];

  if (forKey.length === 1 && added) {
    return {
      type: RowUpdateType.Insert,
      fields: new Set(fieldNames),
      row: added.row,
    };
  }
  if (forKey.length === 1 && removed) {
    return {
      type: RowUpdateType.Delete,
      fields: new Set([primaryKeyField]),
      row: removed.row,
    };
  }
  if (forKey.length === 2 && removed && added) {
    const changed = fieldNames.filter(
      (field) => valueKey(removed.row[field]) !== valueKey(added.row[field]),
    );
    return {
      type: RowUpdateType.Update,
      fields: new Set([primaryKeyField, ...changed]),
      row: added.row,
    };
  }
  throw new KeyViolationError(primaryKeyField, key);
}

// Sums the diffs of identical rows, keeping each row's first appearance
function netIdenticalRows(rows: DiffRow[], fieldNames: string[]): DiffRow[] {
  const netted = new Map<string, DiffRow>();
  for (const { diff, row } of rows) {
    const id = fieldNames.map((field) => valueKey(row[field])).join('\u0000');
    const existing = netted.get(id);
    netted.set(id, { diff: (existing?.diff ?? 0) + diff, row });
  }
  return Array.from(netted.values()).filter((r) => r.diff !== 0);
}

// A comparable form of a value: Dates by instant, bigints by digits, and
// null apart from the string 'null'
function valueKey(value: unknown): string {
  if (value instanceof Date) {
    return `d:${value.toISOString()}`;
  }
  if (typeof value === 'bigint') {
    return `n:${value.toString()}`;
  }
  return `j:${JSON.stringify(value) ?? 'undefined'}`;
}
