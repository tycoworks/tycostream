import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type { OrderByItemBuilder } from 'kysely';
import { OrderDirection } from '../common/types.js';
import type { OrderBy, Row, Selection, StreamMode } from '../common/types.js';
import type { SourceDefinition, SourceField } from '../config/source.types.js';
import { buildCondition } from './filter.js';
import type { RawRow } from './postgres.js';

// Kysely only compiles here; tycostream runs the SQL itself
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

// Each direction a column can sort in, as SQL writes it
const SQL_DIRECTIONS: Record<
  OrderDirection,
  (order: OrderByItemBuilder) => OrderByItemBuilder
> = {
  [OrderDirection.Asc]: (order) => order.asc(),
  [OrderDirection.AscNullsFirst]: (order) => order.asc().nullsFirst(),
  [OrderDirection.AscNullsLast]: (order) => order.asc().nullsLast(),
  [OrderDirection.Desc]: (order) => order.desc(),
  [OrderDirection.DescNullsFirst]: (order) => order.desc().nullsFirst(),
  [OrderDirection.DescNullsLast]: (order) => order.desc().nullsLast(),
};

/**
 * The SELECT that reads a source's rows as a client selects them, in either
 * mode: its columns, its filter as the WHERE, its order as the ORDER BY, and
 * its limit and offset. Source and column names are quoted, and every value
 * is a bind parameter.
 */
export class Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  // The columns it returns, in the source's order, the key among them
  readonly columns: string[];

  /**
   * Throws if the selection is invalid
   */
  constructor(
    readonly source: SourceDefinition,
    { columns, where, orderBy, limit, offset }: Selection,
    readonly mode: StreamMode,
  ) {
    const fields = new Map(source.fields.map((field) => [field.name, field]));
    this.columns = selectedColumns(source, fields, columns);
    let query = db
      .selectFrom(sql.id(source.name).as(source.name))
      .select(this.columns.map((column) => sql.id(column).as(column)));

    if (where && Object.keys(where).length > 0) {
      query = query.where((eb) => buildCondition(eb, where, fields));
    }
    for (const [column, direction] of orderedColumns(orderBy, fields)) {
      query = query.orderBy(sql.id(column), SQL_DIRECTIONS[direction]);
    }
    if (limit !== undefined) {
      query = query.limit(checkNotNegative('limit', limit));
    }
    if (offset !== undefined) {
      query = query.offset(checkNotNegative('offset', offset));
    }

    const compiled = query.compile();
    this.sql = compiled.sql;
    this.parameters = compiled.parameters;
  }

  /**
   * One of the statement's rows, as tycostream serves it: its own columns,
   * with null for a missing value. A row can carry other columns too.
   */
  unpack(raw: RawRow): Row {
    return Object.fromEntries(
      this.columns.map((column) => [column, raw[column] ?? null]),
    );
  }
}

// The columns to select, in the source's order: the ones asked for, or every
// one when none are named, and always the key, which a live stream pairs its
// rows by
function selectedColumns(
  source: SourceDefinition,
  fields: Map<string, SourceField>,
  columns?: string[],
): string[] {
  const names = source.fields.map((field) => field.name);
  if (columns === undefined) {
    return names;
  }
  for (const column of columns) {
    if (!fields.has(column)) {
      throw new Error(`Unknown field '${column}' to select`);
    }
  }
  const wanted = new Set([source.primaryKeyField, ...columns]);
  return names.filter((name) => wanted.has(name));
}

// The ordering's columns and directions, in turn, each a column of the source
function orderedColumns(
  orderBy: OrderBy = [],
  fields: Map<string, SourceField>,
): [string, OrderDirection][] {
  const columns = orderBy.flatMap((item) => Object.entries(item));
  for (const [column] of columns) {
    if (!fields.has(column)) {
      throw new Error(`Unknown field '${column}' to order by`);
    }
  }
  return columns;
}

function checkNotNegative(argument: string, value: number): number {
  if (value < 0) {
    throw new Error(`'${argument}' can't be negative`);
  }
  return value;
}
