import pg from 'pg';
import type { SourceDefinition } from '../config/source.types.js';
import { PostgresType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateBatch, RowUpdateEvent } from '../common/types.js';
import type { CompiledSelect } from './select.js';

/**
 * What every Postgres-compatible database does the same way: typing each
 * value by the type the database reports for its column, and giving a
 * snapshot with a plain SELECT. Any adapter for such a database builds on it.
 */

/**
 * One row as node-postgres gives it, each value typed by its column's type
 */
export type RawRow = Record<string, unknown>;

// A parser for one column's values: from the text the database sends to the
// JavaScript value tycostream serves
type Parser = (text: string) => unknown;

// Postgres writes a timestamp with a space before the time, and an offset of
// whole hours as +00; ISO 8601 has a T, and +00:00
const TEXT_DATE_TIME_SEPARATOR = ' ';
const ISO_DATE_TIME_SEPARATOR = 'T';
const HOURS_ONLY_OFFSET = /([+-]\d{2})$/;

/**
 * A timestamp in ISO 8601, as Postgres writes timestamps in JSON:
 * 2026-01-01 07:30:00+00 becomes 2026-01-01T07:30:00+00:00
 */
export function isoTimestamp(text: string): string {
  return text
    .replace(TEXT_DATE_TIME_SEPARATOR, ISO_DATE_TIME_SEPARATOR)
    .replace(HOURS_ONLY_OFFSET, '$1:00');
}

const asText: Parser = (text) => text;

// The types node-postgres would turn into a Date, an interval object or a
// Buffer, kept as text instead: timestamps in ISO 8601, the rest as written
const KEPT_AS_TEXT = new Map<number, Parser>([
  [PostgresType.Timestamp, isoTimestamp],
  [PostgresType.Timestamptz, isoTimestamp],
  [PostgresType.Date, asText],
  [PostgresType.Interval, asText],
  [PostgresType.Bytea, asText],
]);

/**
 * How node-postgres parses each value, by the type the database reports for
 * its column: with its own parsers, which suit the other types (int8 and
 * numeric stay strings, so they keep every digit; json and jsonb become
 * JSON), except for the types kept as text
 */
export const TYPE_PARSERS = {
  getTypeParser: (type: number): Parser =>
    KEPT_AS_TEXT.get(type) ??
    // node-postgres types its parsers as any
    (pg.types.getTypeParser(type, 'text') as Parser),
};

/**
 * A row with only the source's columns, already parsed; a row can carry
 * other columns too
 */
export function pickRow(source: SourceDefinition, raw: RawRow): Row {
  return Object.fromEntries(
    source.fields.map((field) => [field.name, raw[field.name] ?? null]),
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
    events: rows.map((raw) => insertOf(pickRow(source, raw), fieldNames)),
  };
}
