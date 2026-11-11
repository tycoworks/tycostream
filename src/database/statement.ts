import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from 'kysely';
import type {
  Expression,
  OrderByItemBuilder,
  QueryCreator,
  RawBuilder,
  SelectQueryBuilder,
  SqlBool,
} from 'kysely';
import { OrderDirection, StreamMode } from '../common/types.js';
import type { OrderBy, PostgresType, Row, Selection } from '../common/types.js';
import type {
  Relationship,
  SourceDefinition,
  SourceField,
} from '../config/source.types.js';
import { buildCondition } from './filter.js';
import { parseText } from './postgres.js';
import type { RawRow } from './postgres.js';

/**
 * The names the statement adds of its own. GraphQL reserves names starting
 * with __, so none can be a source's, a column's or a path's.
 */
enum StatementName {
  Source = '__source', // A row's source's number, and its CTE: __source_0
  RowNumber = '__row_number', // The column holding SQL_ROW_NUMBER's numbers, in a query
  Row = '__row', // A row's own columns, as one JSON object
  Rows = '__rows', // A source's rows, before their related rows are joined on
}

// A row related to a source's row by a relationship to one row, at a path of
// fields from it, with the columns selected of it, joined onto the row that
// holds it: the source's, or another related row
interface RelatedRow {
  path: string[];
  relationship: Relationship;
  columns: string[];
  holder: string; // The alias of the row it's joined onto
}

// A list a selection reaches by a relationship to many rows, at a path of
// fields from a source's row, with its own selection
interface List {
  path: string[];
  relationship: Relationship;
  selection: Selection;
}

// What a selection's relationships ask of a source's rows: the related rows
// to join onto each row, and the lists to read as sources of their own
interface Plan {
  related: RelatedRow[];
  lists: List[];
}

// A source the statement reads as rows of its own: the selected rows, or a
// list in them at any depth, read for each row of its parent
interface SelectedSource {
  index: number; // Its rows' tag, and its CTE's number; parents come first
  source: SourceDefinition;
  selection: Selection;
  own: string[]; // Its own selected columns
  related: RelatedRow[];
  types: Map<string, PostgresType>; // Its columns, each with its type
  parent?: Parent; // A list's
}

// How a list's rows are matched to each row of its parent: a column of the
// parent's row, and the column of the list's source that matches it
interface Parent {
  name: string; // The parent's CTE
  column: string; // Named by its path in the parent's row
  relatedColumn: string;
}

type Query = SelectQueryBuilder<any, any, any>;

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

// Joins a path's fields, in a related row's alias and its columns' names, as
// positions.symbol. No GraphQL name contains it.
const PATH_SEPARATOR = '.';

// SQL's window function that numbers rows in their order
const SQL_ROW_NUMBER = 'row_number';

/**
 * The statement that reads a source's rows as a client selects them, with
 * their related rows and lists, at any depth, in either mode. Every
 * statement is built the same way:
 *
 *   sources: the selected rows, then each list in them, parents first      sourcesOf
 *     each one's relationships, planned:                                   plan
 *       to one row:   a related row, joined onto its row
 *       to many rows: a list, a source of its own
 *   for each source, a CTE of its rows:                                    rowsOf
 *     its own rows, filtered, ordered, limited and offset, and in a
 *       query numbered in that order                                       sourceRows
 *     a list's, read for each row of its parent                            forEachParentRow
 *     each related row left joined on                                      withRelatedRows
 *   every row, as its source's number and one JSON object of its
 *     columns, stacked with UNION ALL, a query's ordered by number         statementOf
 *
 * Source and column names are quoted, and every value is a bind parameter.
 */
export class Statement {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  // The selected rows' columns: their source's, in their order, the key among
  // them, then each related row's, named by its path, as positions.symbol
  readonly columns: string[];
  // The sources it reads, by their number: the selected rows, then each list
  private readonly sources: SelectedSource[];

  /**
   * Throws if the selection is invalid
   */
  constructor(
    readonly source: SourceDefinition,
    selection: Selection,
    readonly mode: StreamMode,
  ) {
    this.sources = sourcesOf(source, selection);
    this.columns = [...this.sources[0].types.keys()];
    const compiled = statementOf(
      this.sources,
      mode === StreamMode.Snapshot,
    ).compile();
    this.sql = compiled.sql;
    this.parameters = compiled.parameters;
  }

  /**
   * One of the statement's rows, as tycostream serves it, by its source's
   * number: its columns, each related row's named by its path, each parsed
   * from the text in its JSON by the column's type, as the column's own value
   * would be. A row can carry other columns too.
   */
  unpack(raw: RawRow): Row {
    const { types } = this.sources[raw[StatementName.Source] as number];
    const values = raw[StatementName.Row] as Record<string, string | null>;
    return Object.fromEntries(
      [...types].map(([column, type]) => [
        column,
        parseText(type, values[column] ?? null),
      ]),
    );
  }
}

// ---- Planning: the sources a selection reads, and their related rows ----

// The sources a selection reads as rows of their own: the selected rows, then
// each list in them, at any depth, parents first
function sourcesOf(
  source: SourceDefinition,
  selection: Selection,
): SelectedSource[] {
  const sources: SelectedSource[] = [];
  const add = (
    source: SourceDefinition,
    selection: Selection,
    parent?: Parent,
  ) => {
    const own = selectedColumns(source, fieldsOf(source), selection.columns);
    const { related, lists } = plan(source, selection.relationships);
    const index = sources.length;
    sources.push({
      index,
      source,
      selection,
      own,
      related,
      types: typesOf(source, own, related),
      parent,
    });
    for (const { path, relationship, selection } of lists) {
      add(relationship.source, selection, {
        name: sourceName(index),
        column: pathName([...path.slice(0, -1), relationship.column]),
        relatedColumn: relationship.relatedColumn,
      });
    }
  };
  add(source, selection);
  return sources;
}

// What a selection's relationships ask of a source's rows, at any depth: a
// relationship to one row is joined onto its row, and its own relationships
// are planned in turn; a relationship to many rows is a list, read as a
// source of its own
function plan(
  source: SourceDefinition,
  relationships: Record<string, Selection> = {},
  path: string[] = [],
  holder: string = StatementName.Rows,
): Plan {
  const planned: Plan = { related: [], lists: [] };
  for (const [field, selection] of Object.entries(relationships)) {
    const relationship = relationshipOf(source, field);
    const at = [...path, field];
    if (relationship.many) {
      planned.lists.push({ path: at, relationship, selection });
      continue;
    }
    checkNoArguments(field, selection);
    const related = relationship.source;
    planned.related.push({
      path: at,
      relationship,
      columns: selectedColumns(related, fieldsOf(related), selection.columns),
      holder,
    });
    const inner = plan(related, selection.relationships, at, pathName(at));
    planned.related.push(...inner.related);
    planned.lists.push(...inner.lists);
  }
  return planned;
}

// The statement's columns, each with its type: the source's own, then each
// related row's, named by its path
function typesOf(
  source: SourceDefinition,
  own: string[],
  related: RelatedRow[],
): Map<string, PostgresType> {
  const typed = (of: SourceDefinition, columns: string[], path: string[]) => {
    const fields = fieldsOf(of);
    return columns.map((column): [string, PostgresType] => [
      pathName([...path, column]),
      fields.get(column)!.type,
    ]);
  };
  return new Map([
    ...typed(source, own, []),
    ...related.flatMap(({ path, relationship, columns }) =>
      typed(relationship.source, columns, path),
    ),
  ]);
}

// A related row's selection takes columns and relationships only: one row
// has no filter, order, limit or offset
function checkNoArguments(field: string, selection: Selection): void {
  const { where, orderBy, limit, offset } = selection;
  if ([where, orderBy, limit, offset].some((value) => value !== undefined)) {
    throw new Error(
      `'${field}' is a relationship to one row; it takes no where, order_by, limit or offset`,
    );
  }
}

function relationshipOf(source: SourceDefinition, field: string): Relationship {
  const relationship = source.relationships?.get(field);
  if (!relationship) {
    throw new Error(`Unknown relationship '${field}' of '${source.name}'`);
  }
  return relationship;
}

// ---- Building: each source's rows, and the statement stacking them ----

// The statement: each source's rows as a CTE, then every row as its source's
// number and one JSON object of its columns, stacked with UNION ALL; a
// query's ordered by their numbers, which keep each source's rows in order
// under each parent row
function statementOf(sources: SelectedSource[], numbered: boolean): Query {
  const withSources = sources.reduce<QueryCreator<any>>(
    (creator, selected) =>
      creator.with(sourceName(selected.index), () =>
        rowsOf(selected, numbered),
      ),
    db,
  );
  const rowsFrom = (creator: QueryCreator<any>, selected: SelectedSource) => {
    const name = sourceName(selected.index);
    return creator
      .selectFrom(sql.id(name).as(name))
      .select([
        sql.lit(selected.index).as(StatementName.Source),
        ...(numbered
          ? [sql.id(name, StatementName.RowNumber).as(StatementName.RowNumber)]
          : []),
        rowOf(name, [...selected.types.keys()]).as(StatementName.Row),
      ]);
  };
  const [first, ...lists] = sources;
  const stacked = lists.reduce(
    (union, selected) => union.unionAll(rowsFrom(db, selected)),
    rowsFrom(withSources, first),
  );
  return numbered ? stacked.orderBy(sql.id(StatementName.RowNumber)) : stacked;
}

// A source's rows, as its CTE: its own rows, a list's read for each row of
// its parent, with each related row joined on
function rowsOf(selected: SelectedSource, numbered: boolean): Query {
  const rows = sourceRows(selected, numbered);
  const own = selected.parent
    ? forEachParentRow(rows, selected.source, selected.parent)
    : db.selectFrom(rows.as(StatementName.Rows)).selectAll(StatementName.Rows);
  return withRelatedRows(own, selected.related);
}

// A list's rows, read for each row of its parent, matched on the column of
// the parent's row that holds the list
function forEachParentRow(
  rows: Query,
  source: SourceDefinition,
  parent: Parent,
): Query {
  const matched = rows.where(
    sameValue(
      [source.name, parent.relatedColumn],
      [parent.name, parent.column],
    ),
  );
  return db
    .selectFrom(sql.id(parent.name).as(parent.name))
    .crossJoinLateral(matched.as(StatementName.Rows))
    .selectAll(StatementName.Rows);
}

// A source's own rows: its columns, filtered, ordered, limited and offset by
// its selection, and in a query, each row's number in that order
function sourceRows(
  { source, selection, own, related }: SelectedSource,
  numbered: boolean,
): Query {
  const { where, orderBy, limit, offset } = selection;
  const fields = fieldsOf(source);
  // A related row's join needs its column on the source's row, selected or
  // not; it stays out of the row's JSON
  const columns = selectedColumns(source, fields, [
    ...own,
    ...joinColumns(related),
  ]);
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

// A source's rows, as __rows, with each related row left joined on, after
// their filter, order, limit and offset, at any depth: each onto the row
// holding it, its columns named by its path
function withRelatedRows(rows: Query, related: RelatedRow[]): Query {
  return related.reduce((query, { path, relationship, columns, holder }) => {
    const alias = pathName(path);
    return query
      .leftJoin(sql.id(relationship.source.name).as(alias), (join) =>
        join.on(
          sameValue(
            [alias, relationship.relatedColumn],
            [holder, relationship.column],
          ),
        ),
      )
      .select(
        columns.map((column) =>
          sql.id(alias, column).as(pathName([...path, column])),
        ),
      );
  }, rows);
}

// The source's columns its related rows are joined on: those of the related
// rows joined onto its own row, one field from it
function joinColumns(related: RelatedRow[]): string[] {
  return related
    .filter(({ path }) => path.length === 1)
    .map(({ relationship }) => relationship.column);
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

// Two columns, each a table's, holding the same value. sql.id quotes each
// name whole; Kysely's string references would split a name at a '.'.
function sameValue(
  [leftTable, leftColumn]: [string, string],
  [rightTable, rightColumn]: [string, string],
): Expression<SqlBool> {
  return sql<SqlBool>`${sql.id(leftTable, leftColumn)} = ${sql.id(rightTable, rightColumn)}`;
}

// A source's rows' CTE in the statement: __source_0
function sourceName(index: number): string {
  return `${StatementName.Source}_${index}`;
}

// A related row's alias, or a column's name, in the statement: the fields of
// its path
function pathName(path: string[]): string {
  return path.join(PATH_SEPARATOR);
}

// ---- Columns and order ----

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

// A source's fields, by name
function fieldsOf(source: SourceDefinition): Map<string, SourceField> {
  return new Map(source.fields.map((field) => [field.name, field]));
}
