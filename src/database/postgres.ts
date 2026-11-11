import pg from 'pg';
import { PostgresType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateBatch, RowUpdateEvent } from '../common/types.js';
import type { Statement } from './statement.js';

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
const asNumber: Parser = (text) => Number(text);

// The types tycostream parses its own way. node-postgres would keep int8 and
// numeric as strings; they're numbers, as Hasura sends them by default, which
// keep about 15 significant digits. It would turn the others into a Date, an
// interval object or a Buffer; they're text instead, timestamps in ISO 8601.
const OWN_PARSERS = new Map<number, Parser>([
  [PostgresType.Int8, asNumber],
  [PostgresType.Numeric, asNumber],
  [PostgresType.Timestamp, isoTimestamp],
  [PostgresType.Timestamptz, isoTimestamp],
  [PostgresType.Date, asText],
  [PostgresType.Interval, asText],
  [PostgresType.Bytea, asText],
]);

/**
 * How node-postgres parses each value, by the type the database reports for
 * its column: with its own parsers, which suit the other types (integers and
 * floats become numbers, booleans booleans, and json and jsonb JSON), except
 * for the types tycostream parses its own way
 */
export const TYPE_PARSERS = {
  getTypeParser: (type: number): Parser =>
    OWN_PARSERS.get(type) ??
    // node-postgres types its parsers as any
    (pg.types.getTypeParser(type, 'text') as Parser),
};

/**
 * A value the database wrote as text, as tycostream serves values of its
 * type: what the type parsers make of it as a column's value
 */
export function parseText(type: PostgresType, text: string | null): unknown {
  return text === null ? null : TYPE_PARSERS.getTypeParser(type)(text);
}

/**
 * Thrown when a read's rows can't be explained by one row per key, so the
 * declared primary key isn't unique: a query with a key twice, or a
 * timestamp's changes with one
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
 * A row arriving whole: an insert of every column
 */
export function insertOf(row: Row, fieldNames: string[]): RowUpdateEvent {
  return { type: RowUpdateType.Insert, fields: new Set(fieldNames), row };
}

/**
 * A snapshot, as every Postgres-compatible database gives one: the
 * statement's rows, typed, as one batch of inserts, one per row, even when
 * there are none. A plain SELECT doesn't give its timestamp. Any adapter can
 * read snapshots this way.
 */
export async function* readSnapshot(
  client: pg.ClientBase,
  statement: Statement,
): AsyncGenerator<RowUpdateBatch> {
  const { rows } = await client.query<RawRow>(statement.sql, [
    ...statement.parameters,
  ]);
  yield {
    events: insertsOf(
      rows.map((raw) => statement.unpack(raw)),
      statement.source.primaryKeyField,
      statement.columns,
    ),
  };
}

// A snapshot's rows as inserts, one per row: a key seen twice means the
// source's key isn't unique
function insertsOf(
  rows: Row[],
  primaryKeyField: string,
  fieldNames: string[],
): RowUpdateEvent[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const key = JSON.stringify(row[primaryKeyField]);
    if (seen.has(key)) {
      throw new KeyViolationError(primaryKeyField, row[primaryKeyField]);
    }
    seen.add(key);
    return insertOf(row, fieldNames);
  });
}
