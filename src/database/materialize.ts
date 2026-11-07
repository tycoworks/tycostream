import type pg from 'pg';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType, RowUpdateType } from '../common/types.js';
import type { RowUpdateEvent } from '../common/types.js';
import type { CompiledQuery } from './query.js';
import type { ProtocolHandler } from './types.js';

/**
 * One fetched row as Materialize sends it: every column as text, or null,
 * since tycostream's connections read every value as text
 */
export type RawRow = Record<string, string | null>;

/**
 * One row of a subscription's changes: +1 when it was added, -1 when it was
 * removed, and the row's values
 */
export interface DiffRow {
  diff: number;
  row: Record<string, unknown>;
}

const CURSOR = 'c';

// The columns SUBSCRIBE adds to each row, before the row's own
enum SubscribeColumn {
  Timestamp = 'mz_timestamp',
  Progressed = 'mz_progressed',
  Diff = 'mz_diff',
}

// How Postgres writes a true boolean as text
const TEXT_TRUE = 't';

// Joins a row's values into one key; no value's text can contain it
const VALUE_SEPARATOR = '\u0000';

// FETCH waits until rows exist, so a bigger batch only helps a busy view
const FETCH_SIZE = 1000;

/**
 * Handles Materialize-specific protocol details: reads
 * SUBSCRIBE (<query>) WITH (SNAPSHOT, PROGRESS) through a cursor
 */
export class MaterializeProtocolHandler implements ProtocolHandler {
  constructor(private readonly sourceDefinition: SourceDefinition) {}

  /**
   * Never ends by itself; it stops when the connection closes
   */
  async *read(
    client: pg.ClientBase,
    query: CompiledQuery,
  ): AsyncGenerator<RowUpdateEvent[]> {
    // The transaction sits idle while the consumer works through a batch.
    // Materialize's cap on a subscription's backlog limits a slow consumer,
    // so its idle timeout shouldn't
    await client.query('SET idle_in_transaction_session_timeout = 0');
    // A cursor only lives inside a transaction
    await client.query('BEGIN');
    await client.query(
      `DECLARE ${CURSOR} CURSOR FOR SUBSCRIBE (${query.sql}) WITH (SNAPSHOT, PROGRESS)`,
      [...query.parameters],
    );

    // FETCH without a timeout returns as soon as rows exist
    const batcher = new ProgressBatcher(this.sourceDefinition);
    const { primaryKeyField, fields } = this.sourceDefinition;
    const fieldNames = fields.map((field) => field.name);
    while (true) {
      const { rows } = await client.query<RawRow>(
        `FETCH ${FETCH_SIZE} ${CURSOR}`,
      );
      for (const batch of batcher.take(rows)) {
        const events = pairChanges(batch, primaryKeyField, fieldNames);
        // A timestamp whose changes cancel out has nothing to send
        if (events.length > 0) {
          yield events;
        }
      }
    }
  }
}

/**
 * Holds a subscription's rows until a progress row says their timestamp is
 * complete, typing each value as the schema says
 */
export class ProgressBatcher {
  private readonly pending = new Map<bigint, DiffRow[]>();

  constructor(private readonly sourceDefinition: SourceDefinition) {}

  /**
   * Takes fetched rows and returns each timestamp they complete, oldest
   * first. A progress row at timestamp t means every timestamp before t is
   * complete; the snapshot is the first complete timestamp.
   */
  take(rows: RawRow[]): DiffRow[][] {
    const complete: DiffRow[][] = [];
    for (const raw of rows) {
      const timestamp = BigInt(raw[SubscribeColumn.Timestamp]!);
      if (raw[SubscribeColumn.Progressed] === TEXT_TRUE) {
        for (const done of [...this.pending.keys()]
          .filter((t) => t < timestamp)
          .sort((a, b) => (a < b ? -1 : 1))) {
          complete.push(this.pending.get(done)!);
          this.pending.delete(done);
        }
      } else {
        const batch = this.pending.get(timestamp) ?? [];
        batch.push({
          diff: Number(raw[SubscribeColumn.Diff]),
          row: this.parseRow(raw),
        });
        this.pending.set(timestamp, batch);
      }
    }
    return complete;
  }

  private parseRow(raw: RawRow): Record<string, unknown> {
    return Object.fromEntries(
      this.sourceDefinition.fields.map((field) => {
        const value = raw[field.name];
        return [
          field.name,
          value === null ? null : parseValue(value, field.dataType),
        ];
      }),
    );
  }
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
    const id = fieldNames
      .map((field) => valueKey(row[field]))
      .join(VALUE_SEPARATOR);
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

/**
 * Parse a column's text value into the type the GraphQL schema serves
 */
function parseValue(value: string, dataType: DataType): unknown {
  switch (dataType) {
    case DataType.Boolean:
      return value === TEXT_TRUE;

    case DataType.Integer:
      return parseInt(value, 10);

    case DataType.Float:
      return parseFloat(value);

    case DataType.BigInt:
      // Keep as string to preserve precision
      return value;

    // All string-based types
    case DataType.String:
    case DataType.UUID:
    case DataType.Timestamp:
    case DataType.Date:
    case DataType.Time:
    case DataType.JSON:
    case DataType.Array:
      return value;

    default:
      return value;
  }
}
