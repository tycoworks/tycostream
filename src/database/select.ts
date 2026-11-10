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
  ExpressionBuilder,
  OrderByItemBuilder,
  SelectQueryBuilder,
  SqlBool,
} from 'kysely';
import {
  ComparisonOperator,
  LogicalOperator,
  OrderDirection,
} from '../common/types.js';
import type {
  FieldComparison,
  OrderBy,
  Row,
  Selection,
  WhereClause,
} from '../common/types.js';
import type { SourceDefinition, SourceField } from '../config/source.types.js';

export interface CompiledSelect {
  sql: string;
  parameters: readonly unknown[];
}

// Joins the fields on the path to a joined row's column, as in
// positions.symbol, and to its table; no GraphQL name contains it
const PATH_SEPARATOR = '.';

// Kysely only compiles here; tycostream runs the SQL itself
const db = new Kysely<any>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new PostgresIntrospector(kysely),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

type OrderingOperator =
  | ComparisonOperator.Gt
  | ComparisonOperator.Gte
  | ComparisonOperator.Lt
  | ComparisonOperator.Lte;

const SQL_COMPARISONS = {
  [ComparisonOperator.Eq]: '=',
  [ComparisonOperator.Neq]: '<>',
  [ComparisonOperator.Gt]: '>',
  [ComparisonOperator.Gte]: '>=',
  [ComparisonOperator.Lt]: '<',
  [ComparisonOperator.Lte]: '<=',
} as const;

type SetOperator = ComparisonOperator.In | ComparisonOperator.Nin;

// Text patterns, matched by the database: Materialize's regular expressions
// use Rust's syntax, not POSIX
const SQL_PATTERNS = {
  [ComparisonOperator.Like]: 'like',
  [ComparisonOperator.Nlike]: 'not like',
  [ComparisonOperator.Ilike]: 'ilike',
  [ComparisonOperator.Nilike]: 'not ilike',
  [ComparisonOperator.Regex]: '~',
  [ComparisonOperator.Nregex]: '!~',
  [ComparisonOperator.Iregex]: '~*',
  [ComparisonOperator.Niregex]: '!~*',
} as const;

const SQL_SETS = {
  [ComparisonOperator.In]: 'in',
  [ComparisonOperator.Nin]: 'not in',
} as const;

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

type Builder = ExpressionBuilder<any, any>;
type Condition = Expression<SqlBool>;
type Query = SelectQueryBuilder<any, any, any>;

/**
 * Builds the SELECT for a source and a client's selection: its columns, and
 * each row it joins through a foreign key, its filter as the WHERE, its order
 * as the ORDER BY, and its limit and offset. Every column is qualified by its
 * table, as joined tables can share column names. Source and column names
 * are quoted, and every value is a bind parameter.
 */
export function buildSelect(
  source: SourceDefinition,
  selection: Selection = {},
): CompiledSelect {
  const { where, orderBy, limit, offset } = selection;
  const fields = new Map(source.fields.map((field) => [field.name, field]));
  const table = source.name;
  let query = selectRow(
    db.selectFrom(sql.id(source.name).as(table)),
    source,
    table,
    [],
    selection,
  );

  if (where && Object.keys(where).length > 0) {
    query = query.where((eb) => buildCondition(eb, table, where, fields));
  }
  for (const [column, direction] of orderedColumns(orderBy, fields)) {
    query = query.orderBy(sql.id(table, column), SQL_DIRECTIONS[direction]);
  }
  if (limit !== undefined) {
    query = query.limit(checkNotNegative('limit', limit));
  }
  if (offset !== undefined) {
    query = query.offset(checkNotNegative('offset', offset));
  }

  const compiled = query.compile();
  return { sql: compiled.sql, parameters: compiled.parameters };
}

/**
 * Folds a row's path-named columns back into objects, at any depth:
 * { id: 1, 'positions.net_position': 600 } becomes
 * { id: 1, positions: { net_position: 600 } }. A joined row whose columns
 * are all null is null: nothing matched, since its key is always selected.
 */
export function nestRow(flat: Record<string, unknown>): Row {
  const row: Row = {};
  const joined = new Map<string, Record<string, unknown>>();
  for (const [name, value] of Object.entries(flat)) {
    const [field, ...path] = name.split(PATH_SEPARATOR);
    if (path.length === 0) {
      row[field] = value;
    } else {
      const columns = joined.get(field) ?? {};
      columns[path.join(PATH_SEPARATOR)] = value;
      joined.set(field, columns);
    }
  }
  for (const [field, columns] of joined) {
    row[field] = Object.values(columns).every((value) => value === null)
      ? null
      : nestRow(columns);
  }
  return row;
}

// Selects a source's columns, named by their path, and left joins each row
// the selection joins, on its foreign key, in a table named by its path, then
// selects that row the same way. For trades joining positions:
//   "trades"."quantity" as "quantity",
//   "trades.positions"."net_position" as "positions.net_position"
//   ... left join "positions" as "trades.positions"
//         on "trades.positions"."instrument_id" = "trades"."instrument_id"
function selectRow(
  query: Query,
  source: SourceDefinition,
  table: string,
  path: string[],
  { columns, joins = {} }: Selection,
): Query {
  query = query.select(
    selectedColumns(source, columns).map((column) =>
      sql.id(table, column).as([...path, column].join(PATH_SEPARATOR)),
    ),
  );
  for (const [field, selection] of Object.entries(joins)) {
    const foreignKey = source.foreignKeys?.find(
      ({ references }) => references.name === field,
    );
    if (!foreignKey) {
      throw new Error(`Unknown relationship '${field}' of '${source.name}'`);
    }
    const { references } = foreignKey;
    const joinedTable = [table, field].join(PATH_SEPARATOR);
    query = query.leftJoin(sql.id(references.name).as(joinedTable), (join) =>
      join.on(
        sql<SqlBool>`${sql.id(joinedTable, references.primaryKeyField)} = ${sql.id(table, foreignKey.column)}`,
      ),
    );
    query = selectRow(
      query,
      references,
      joinedTable,
      [...path, field],
      selection,
    );
  }
  return query;
}

// The columns to select, in the source's order: the ones asked for, or every
// one when none are named, and always the key, which a live stream pairs its
// rows by, and which tells a joined row from none
function selectedColumns(
  source: SourceDefinition,
  columns?: string[],
): string[] {
  const names = source.fields.map((field) => field.name);
  if (columns === undefined) {
    return names;
  }
  for (const column of columns) {
    if (!names.includes(column)) {
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

function buildCondition(
  eb: Builder,
  table: string,
  where: WhereClause,
  fields: Map<string, SourceField>,
): Condition {
  const conditions = Object.entries(where).flatMap(([key, value]) => {
    // A key is either a logical operator or a field name
    const operator = key as LogicalOperator;
    switch (operator) {
      case LogicalOperator.And:
      case LogicalOperator.Or: {
        const children = (value as WhereClause[]).map((w) =>
          buildCondition(eb, table, w, fields),
        );
        return [
          operator === LogicalOperator.And ? eb.and(children) : eb.or(children),
        ];
      }
      case LogicalOperator.Not:
        return [
          eb.not(buildCondition(eb, table, value as WhereClause, fields)),
        ];
      default: {
        const field = fields.get(key);
        if (!field) {
          throw new Error(`Unknown field '${key}'`);
        }
        return buildComparisons(eb, table, field, value as FieldComparison);
      }
    }
  });
  return eb.and(conditions);
}

function buildComparisons(
  eb: Builder,
  table: string,
  field: SourceField,
  comparison: FieldComparison,
): Condition[] {
  const column = sql.id(table, field.name);
  const enumValues = field.enumType?.values;

  return Object.entries(comparison).map(([key, value]) => {
    const operator = key as ComparisonOperator;
    checkNotNull(field, operator, value);
    if (enumValues) {
      checkEnumValues(field, operator, value);
    }
    switch (operator) {
      case ComparisonOperator.Eq:
      case ComparisonOperator.Neq:
        return eb(column, SQL_COMPARISONS[operator], value);
      case ComparisonOperator.Gt:
      case ComparisonOperator.Gte:
      case ComparisonOperator.Lt:
      case ComparisonOperator.Lte:
        // Enums order by their declared values, not alphabetically, so an
        // ordering becomes the set of values on its side
        return enumValues
          ? inSet(
              eb,
              column,
              ComparisonOperator.In,
              enumValuesOnSide(enumValues, operator, value),
            )
          : eb(column, SQL_COMPARISONS[operator], value);
      case ComparisonOperator.In:
      case ComparisonOperator.Nin:
        return inSet(eb, column, operator, value as unknown[]);
      case ComparisonOperator.IsNull:
        return eb(column, value ? 'is' : 'is not', null);
      case ComparisonOperator.Like:
      case ComparisonOperator.Nlike:
      case ComparisonOperator.Ilike:
      case ComparisonOperator.Nilike:
      case ComparisonOperator.Regex:
      case ComparisonOperator.Nregex:
      case ComparisonOperator.Iregex:
      case ComparisonOperator.Niregex:
        return eb(column, SQL_PATTERNS[operator], value);
      default:
        throw new Error(`Unknown operator '${key}' on '${field.name}'`);
    }
  });
}

// An empty list isn't valid SQL: nothing is in it, and everything is outside it
function inSet(
  eb: Builder,
  column: Expression<unknown>,
  operator: SetOperator,
  values: unknown[],
): Condition {
  return values.length === 0
    ? sql.lit(operator === ComparisonOperator.Nin)
    : eb(column, SQL_SETS[operator], values);
}

function enumValuesOnSide(
  enumValues: string[],
  operator: OrderingOperator,
  value: unknown,
): string[] {
  const index = enumValues.indexOf(value as string);
  switch (operator) {
    case ComparisonOperator.Gt:
      return enumValues.slice(index + 1);
    case ComparisonOperator.Gte:
      return enumValues.slice(index);
    case ComparisonOperator.Lt:
      return enumValues.slice(0, index);
    case ComparisonOperator.Lte:
      return enumValues.slice(0, index + 1);
  }
}

// SQL compares nothing equal to null, so a null value would silently match
// no rows; _is_null is how to match nulls
function checkNotNull(
  field: SourceField,
  operator: ComparisonOperator,
  value: unknown,
): void {
  if (operator === ComparisonOperator.IsNull) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  if (values.some((v) => v === null || v === undefined)) {
    throw new Error(
      `'${operator}' on '${field.name}' can't compare with null; use '${ComparisonOperator.IsNull}'`,
    );
  }
}

function checkEnumValues(
  field: SourceField,
  operator: ComparisonOperator,
  value: unknown,
): void {
  if (operator === ComparisonOperator.IsNull) {
    return;
  }
  const values = Array.isArray(value) ? value : [value];
  for (const v of values) {
    if (!field.enumType!.values.includes(v as string)) {
      throw new Error(
        `Invalid value '${String(v)}' for enum '${field.enumType!.name}' on '${field.name}'`,
      );
    }
  }
}
