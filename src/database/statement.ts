import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type { Expression, OrderByItemBuilder, RawBuilder } from 'kysely';
import { OrderDirection, StreamMode } from '../common/types.js';
import type { OrderBy, PostgresType, Row, Selection } from '../common/types.js';
import type { SourceDefinition, SourceField } from '../config/source.types.js';
import { buildCondition } from './filter.js';
import { parseText } from './postgres.js';
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
 * The names the statement adds of its own. GraphQL reserves names starting
 * with __, so none can be a source's or a column's.
 */
enum StatementName {
  Source = '__source', // A source's rows, as a CTE: __source_0
  RowNumber = '__row_number', // The column holding SQL_ROW_NUMBER's numbers, in a query
  Row = '__row', // A row's own columns, as one JSON object
}

// SQL's window function that numbers rows in their order
const SQL_ROW_NUMBER = 'row_number';

/**
 * The statement that reads a source's rows as a client selects them, in
 * either mode: the source's rows, filtered, ordered, limited and offset by
 * the selection, as a CTE; then each row from the CTE as one JSON object of
 * its columns, in a query in their order. Every statement is built this way.
 * Source and column names are quoted, and every value is a bind parameter.
 */
export class Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  // The columns it returns, in the source's order, the key among them
  readonly columns: string[];
  // Each column's type, which its value is parsed by
  private readonly types: Map<string, PostgresType>;

  /**
   * Throws if the selection is invalid
   */
  constructor(
    readonly source: SourceDefinition,
    selection: Selection,
    readonly mode: StreamMode,
  ) {
    const fields = new Map(source.fields.map((field) => [field.name, field]));
    this.columns = selectedColumns(source, fields, selection.columns);
    this.types = new Map(
      this.columns.map((column) => [column, fields.get(column)!.type]),
    );
    const numbered = mode === StreamMode.Snapshot;
    const name = sourceName(0);
    const compiled = db
      .with(name, () =>
        sourceRows(source, fields, this.columns, selection, numbered),
      )
      .selectFrom(sql.id(name).as(name))
      .select(rowOf(name, this.columns).as(StatementName.Row))
      .$if(numbered, (query) =>
        query.orderBy(sql.id(name, StatementName.RowNumber)),
      )
      .compile();
    this.sql = compiled.sql;
    this.parameters = compiled.parameters;
  }

  /**
   * One of the statement's rows, as tycostream serves it: its own columns,
   * each parsed from the text in its JSON by the column's type, as the
   * column's own value would be. A row can carry other columns too.
   */
  unpack(raw: RawRow): Row {
    const values = raw[StatementName.Row] as Record<string, string | null>;
    return Object.fromEntries(
      [...this.types].map(([column, type]) => [
        column,
        parseText(type, values[column] ?? null),
      ]),
    );
  }
}

// A source's rows: its columns, filtered, ordered, limited and offset by the
// selection, and in a query, each row's number in that order
function sourceRows(
  source: SourceDefinition,
  fields: Map<string, SourceField>,
  columns: string[],
  { where, orderBy, limit, offset }: Selection,
  numbered: boolean,
) {
  const order = orderedColumns(orderBy, fields).map(
    ([column, direction]) =>
      [sql.id(column), SQL_DIRECTIONS[direction]] as const,
  );
  let rows = db
    .selectFrom(sql.id(source.name).as(source.name))
    .select(columns.map((column) => sql.id(column).as(column)));
  if (where && Object.keys(where).length > 0) {
    rows = rows.where((eb) => buildCondition(eb, where, fields));
  }
  for (const [column, direction] of order) {
    rows = rows.orderBy(column, direction);
  }
  if (limit !== undefined) {
    rows = rows.limit(checkNotNegative('limit', limit));
  }
  if (offset !== undefined) {
    rows = rows.offset(checkNotNegative('offset', offset));
  }
  return numbered
    ? rows.select(
        db.fn
          .agg<number>(SQL_ROW_NUMBER)
          .over((over) =>
            order.reduce(
              (by, [column, direction]) => by.orderBy(column, direction),
              over,
            ),
          )
          .as(StatementName.RowNumber),
      )
    : rows;
}

// A row of a source's rows, from their CTE: one JSON object of its columns,
// each value as the text the database would send for it, so tycostream parses
// it as it would the column's. Native JSON values would differ: a float of
// 1e39 or more, or infinite, raises an error, and timestamps aren't ISO.
function rowOf(name: string, columns: string[]): RawBuilder<unknown> {
  return jsonbBuildObject(
    Object.fromEntries(
      columns.map((column) => [column, asText(sql.id(name, column))]),
    ),
  );
}

// Kysely's jsonBuildObject, as jsonb: Materialize has no json_build_object
function jsonbBuildObject(
  object: Record<string, Expression<unknown>>,
): RawBuilder<unknown> {
  return sql`jsonb_build_object(${sql.join(
    Object.entries(object).flatMap(([key, value]) => [sql.lit(key), value]),
  )})`;
}

// A value as the text the database writes for it
function asText(value: Expression<unknown>): RawBuilder<string> {
  return sql<string>`cast(${value} as text)`;
}

// A source's rows' CTE in the statement: __source_0
function sourceName(index: number): string {
  return `${StatementName.Source}_${index}`;
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
