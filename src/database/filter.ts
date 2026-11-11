import { sql } from 'kysely';
import type { Expression, ExpressionBuilder, SqlBool } from 'kysely';
import { ComparisonOperator, LogicalOperator } from '../common/types.js';
import type { FieldComparison, WhereClause } from '../common/types.js';
import type { SourceField } from '../config/source.types.js';

/**
 * A client's `where` filter as SQL conditions on a source's columns
 */

type Builder = ExpressionBuilder<any, any>;
type Condition = Expression<SqlBool>;

type OrderingOperator =
  | ComparisonOperator.Gt
  | ComparisonOperator.Gte
  | ComparisonOperator.Lt
  | ComparisonOperator.Lte;

type SetOperator = ComparisonOperator.In | ComparisonOperator.Nin;

const SQL_COMPARISONS = {
  [ComparisonOperator.Eq]: '=',
  [ComparisonOperator.Neq]: '<>',
  [ComparisonOperator.Gt]: '>',
  [ComparisonOperator.Gte]: '>=',
  [ComparisonOperator.Lt]: '<',
  [ComparisonOperator.Lte]: '<=',
} as const;

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

/**
 * The condition a `where` filter sets on a source's rows: each field's
 * comparisons, and _and, _or and _not of further filters. Throws if a field
 * or an operator is unknown, or a value can't be compared.
 */
export function buildCondition(
  eb: Builder,
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
          buildCondition(eb, w, fields),
        );
        return [
          operator === LogicalOperator.And ? eb.and(children) : eb.or(children),
        ];
      }
      case LogicalOperator.Not:
        return [eb.not(buildCondition(eb, value as WhereClause, fields))];
      default: {
        const field = fields.get(key);
        if (!field) {
          throw new Error(`Unknown field '${key}'`);
        }
        return buildComparisons(eb, field, value as FieldComparison);
      }
    }
  });
  return eb.and(conditions);
}

function buildComparisons(
  eb: Builder,
  field: SourceField,
  comparison: FieldComparison,
): Condition[] {
  const column = sql.id(field.name);
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
