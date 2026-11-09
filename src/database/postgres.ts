import type pg from 'pg';
import type { SourceDefinition } from '../config/source.types.js';
import { PostgresType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateBatch, RowUpdateEvent } from '../common/types.js';
import type { CompiledSelect } from './select.js';

/**
 * What every Postgres-compatible database does the same way: sending rows as
 * text, which tycostream types by the schema, and giving a snapshot with a
 * plain SELECT. Any adapter for such a database builds on it.
 */

/**
 * One row as the database sends it: every column as text, or null
 */
export type RawRow = Record<string, string | null>;

// Has the database send every value as text, so the schema decides the types
export const TEXT_ONLY = { getTypeParser: () => (value: string) => value };

// How Postgres writes a true boolean as text
export const TEXT_TRUE = 't';

/**
 * Types a row's text values as the source's schema says, keeping only the
 * schema's columns
 */
export function parseRow(source: SourceDefinition, raw: RawRow): Row {
  return Object.fromEntries(
    source.fields.map((field) => {
      const value = raw[field.name];
      return [
        field.name,
        value === null ? null : parseValue(value, field.type),
      ];
    }),
  );
}

/**
 * A row arriving whole: an insert of every column
 */
export function insertOf(row: Row, fieldNames: string[]): RowUpdateEvent {
  return { type: RowUpdateType.Insert, fields: new Set(fieldNames), row };
}

/**
 * A snapshot, as every Postgres-compatible database gives one: the SELECT's
 * rows, typed, as one batch of inserts, even when there are none. A plain
 * SELECT doesn't give its timestamp. Any adapter can read snapshots this way.
 */
export async function* readSnapshot(
  client: pg.ClientBase,
  source: SourceDefinition,
  select: CompiledSelect,
): AsyncGenerator<RowUpdateBatch> {
  const { rows } = await client.query<RawRow>(select.sql, [
    ...select.parameters,
  ]);
  const fieldNames = source.fields.map((field) => field.name);
  yield {
    events: rows.map((raw) => insertOf(parseRow(source, raw), fieldNames)),
  };
}

/**
 * Parses a column's text value into the JavaScript value its Postgres type
 * becomes: booleans and the numbers a JavaScript number holds exactly, and
 * the rest as the database writes them, so int8 and numeric keep every digit
 */
function parseValue(value: string, type: PostgresType): unknown {
  switch (type) {
    case PostgresType.Bool:
      return value === TEXT_TRUE;
    case PostgresType.Int2:
    case PostgresType.Int4:
      return parseInt(value, 10);
    case PostgresType.Float4:
    case PostgresType.Float8:
      return parseFloat(value);
    default:
      return value;
  }
}
