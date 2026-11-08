/**
 * Our internal type system for field types
 * This maintains semantic information needed across layers
 * without being tied to any specific layer's type system
 */

/**
 * Internal data types that maintain semantic distinctions
 * These preserve the fidelity needed for correct type mapping
 */
export enum DataType {
  // Numeric types
  Integer,
  Float,
  BigInt, // Special handling - stored as string to preserve precision

  // String types
  String,
  UUID,

  // Temporal types
  Timestamp,
  Date,
  Time,

  // Other types
  Boolean,
  JSON, // JSON/JSONB data
  Array, // Array types
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
 * A client's filter, as it arrives in a subscription's `where` argument
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
 * Row update event types sent to GraphQL clients
 * Maps to GraphQL's RowOperation enum (INSERT/UPDATE/DELETE)
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
 * How a stream on a source runs. Both start with the snapshot: the source's
 * current rows that match the filter, as one batch of inserts.
 */
export enum StreamMode {
  // The snapshot, then the stream ends: a GraphQL query
  Snapshot,
  // The snapshot, then every change: a GraphQL subscription
  Live,
}
