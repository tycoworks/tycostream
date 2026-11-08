import type { SourceDefinition } from '../config/source.types.js';
import { DataType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateEvent } from '../common/types.js';

/**
 * How every Postgres-compatible database sends rows when asked for text,
 * and how tycostream types them by the schema. Both stream protocols use it.
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
        value === null ? null : parseValue(value, field.dataType),
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
