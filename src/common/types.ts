import { builtins } from 'pg-types';

/**
 * The Postgres types tycostream serves, each with the type ID Postgres gives
 * it, which every Postgres-compatible database reports. tycostream uses these
 * throughout, until the API presents them as GraphQL. This is the only place
 * that uses pg-types.
 */
export const PostgresType = {
  Int2: builtins.INT2,
  Int4: builtins.INT4,
  Int8: builtins.INT8,
  Float4: builtins.FLOAT4,
  Float8: builtins.FLOAT8,
  Numeric: builtins.NUMERIC,
  Text: builtins.TEXT,
  Varchar: builtins.VARCHAR,
  Bpchar: builtins.BPCHAR,
  Bool: builtins.BOOL,
  Uuid: builtins.UUID,
  Timestamp: builtins.TIMESTAMP,
  Timestamptz: builtins.TIMESTAMPTZ,
  Date: builtins.DATE,
  Time: builtins.TIME,
  Interval: builtins.INTERVAL,
  Json: builtins.JSON,
  Jsonb: builtins.JSONB,
  Bytea: builtins.BYTEA,
} as const;
export type PostgresType = (typeof PostgresType)[keyof typeof PostgresType];

// Each served type's name in Postgres's catalog (pg_type.typname), such as
// int4, as pg-types gives it, in capitals
const SERVED = new Set<number>(Object.values(PostgresType));
const NAMES = new Map<PostgresType, string>(
  (Object.entries(builtins) as [string, number][])
    .filter(([, type]) => SERVED.has(type))
    .map(([name, type]) => [type, name.toLowerCase()]),
);
const TYPES_BY_NAME = new Map<string, PostgresType>(
  [...NAMES].map(([type, name]) => [name, type]),
);

/**
 * A Postgres type's name, as its catalog writes it: int4, timestamptz, ...
 */
export function postgresTypeName(type: PostgresType): string {
  return NAMES.get(type)!;
}

/**
 * The served Postgres type of that name, as its catalog writes it, if any
 */
export function postgresTypeNamed(name: string): PostgresType | undefined {
  return TYPES_BY_NAME.get(name);
}

/**
 * Comparison operators a client can use on a field in a `where` filter
 */
export enum ComparisonOperator {
  Eq = '_eq',
  Neq = '_neq',
  Gt = '_gt',
  Gte = '_gte',
  Lt = '_lt',
  Lte = '_lte',
  In = '_in',
  Nin = '_nin',
  IsNull = '_is_null',
  // Text patterns: LIKE's wildcards, case-sensitive or not, and regular
  // expressions, case-sensitive or not; each with its negation
  Like = '_like',
  Nlike = '_nlike',
  Ilike = '_ilike',
  Nilike = '_nilike',
  Regex = '_regex',
  Nregex = '_nregex',
  Iregex = '_iregex',
  Niregex = '_niregex',
}

/**
 * Operators that combine conditions in a `where` filter
 */
export enum LogicalOperator {
  And = '_and',
  Or = '_or',
  Not = '_not',
}

/**
 * A client's filter, as it arrives in a query's or subscription's `where`
 * argument
 */
export type WhereClause = {
  [LogicalOperator.And]?: WhereClause[];
  [LogicalOperator.Or]?: WhereClause[];
  [LogicalOperator.Not]?: WhereClause;
} & {
  [field: string]: FieldComparison | WhereClause[] | WhereClause | undefined;
};

/**
 * The comparisons on one field of a `where` filter
 */
export type FieldComparison = {
  [operator in ComparisonOperator]?: unknown;
};

/**
 * Which way a column sorts, and where its nulls go
 */
export enum OrderDirection {
  Asc = 'asc',
  AscNullsFirst = 'asc_nulls_first',
  AscNullsLast = 'asc_nulls_last',
  Desc = 'desc',
  DescNullsFirst = 'desc_nulls_first',
  DescNullsLast = 'desc_nulls_last',
}

/**
 * A client's ordering: columns and their directions, applied in turn
 */
export type OrderBy = Record<string, OrderDirection>[];

/**
 * Which of a source's columns and rows a client wants, in what order, and
 * which slice of them, as a SELECT would say: its columns, the rows it
 * joins, its filter, its order, and its limit and offset
 */
export interface Selection {
  // Every column when absent; the key is always selected
  columns?: string[];
  // The selection of each related row it joins, by the relationship's field
  joins?: Record<string, Selection>;
  where?: WhereClause;
  orderBy?: OrderBy;
  limit?: number;
  offset?: number;
}

/**
 * Row update event types sent to GraphQL clients
 * Maps to GraphQL's row_operation enum (INSERT/UPDATE/DELETE)
 */
export enum RowUpdateType {
  Insert,
  Update,
  Delete,
}

/**
 * One row of a source, its values typed as the schema says
 */
export type Row = Record<string, unknown>;

/**
 * Row update event sent to GraphQL subscriptions
 * fields: set of field names that are relevant for this event
 *   - INSERT: all field names
 *   - UPDATE: changed field names (including primary key)
 *   - DELETE: primary key only
 * row: complete row data (always present)
 */
export interface RowUpdateEvent {
  type: RowUpdateType;
  fields: Set<string>; // Field names relevant to this event
  row: Row; // Complete row data
}

/**
 * A stream's row events at one complete timestamp. A stream's first batch
 * is its snapshot, even when it has no rows.
 */
export interface RowUpdateBatch {
  // The database's timestamp for the events, when it gives one: a live
  // stream's batches always have it; a snapshot read by a plain SELECT
  // doesn't
  timestamp?: bigint;
  events: RowUpdateEvent[];
}

/**
 * How a stream on a source runs. Both start with the snapshot: the source's
 * current rows that its selection selects, as one batch of inserts.
 */
export enum StreamMode {
  // The snapshot, then the stream ends: a GraphQL query
  Snapshot,
  // The snapshot, then every change: a GraphQL subscription
  Live,
}
