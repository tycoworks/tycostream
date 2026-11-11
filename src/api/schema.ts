import type {
  SourceDefinition,
  SourceField,
  EnumType,
  SourceConfiguration,
} from '../config/source.types.js';
import {
  ComparisonOperator,
  LogicalOperator,
  OrderDirection,
  PostgresType,
} from '../common/types.js';
import { GraphQLRowOperation } from './tree.js';
import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
} from 'graphql';

/**
 * The root types' names
 */
export enum RootType {
  Query = 'query_root',
  Subscription = 'subscription_root',
}

/**
 * The arguments every root field takes: a selection of a source's rows
 */
export enum RootFieldArgument {
  Where = 'where',
  OrderBy = 'order_by',
  Limit = 'limit',
  Offset = 'offset',
}

/**
 * The fields of every update type
 */
export enum UpdateField {
  Operation = 'operation',
  Data = 'data',
  Fields = 'fields',
}

// The generated types' names
const ROW_OPERATION_TYPE = 'row_operation';
const ORDER_DIRECTION_TYPE = 'order_by';
const orderByTypeName = (sourceName: string) => `${sourceName}_order_by`;
const boolExpTypeName = (sourceName: string) => `${sourceName}_bool_exp`;
const comparisonTypeName = (typeName: string) => `${typeName}_comparison_exp`;
const updateTypeName = (sourceName: string) => `${sourceName}_update`;

/**
 * The GraphQL scalars tycostream declares, for the Postgres types GraphQL's
 * own scalars don't fit, each named after its Postgres type
 */
enum CustomScalar {
  SmallInt = 'smallint',
  BigInt = 'bigint',
  Float8 = 'float8',
  Numeric = 'numeric',
  Bpchar = 'bpchar',
  Uuid = 'uuid',
  Timestamp = 'timestamp',
  Timestamptz = 'timestamptz',
  Date = 'date',
  Time = 'time',
  Interval = 'interval',
  Json = 'json',
  Jsonb = 'jsonb',
  Bytea = 'bytea',
}
const CUSTOM_SCALARS: ReadonlySet<string> = new Set(
  Object.values(CustomScalar),
);

/**
 * Each Postgres type's GraphQL scalar: GraphQL's own where one fits, and a
 * custom one for the rest
 */
const SCALARS: Record<PostgresType, string> = {
  [PostgresType.Int2]: CustomScalar.SmallInt,
  [PostgresType.Int4]: GraphQLInt.name,
  [PostgresType.Int8]: CustomScalar.BigInt,
  [PostgresType.Float4]: GraphQLFloat.name,
  [PostgresType.Float8]: CustomScalar.Float8,
  [PostgresType.Numeric]: CustomScalar.Numeric,
  [PostgresType.Text]: GraphQLString.name,
  [PostgresType.Varchar]: GraphQLString.name,
  [PostgresType.Bpchar]: CustomScalar.Bpchar,
  [PostgresType.Bool]: GraphQLBoolean.name,
  [PostgresType.Uuid]: CustomScalar.Uuid,
  [PostgresType.Timestamp]: CustomScalar.Timestamp,
  [PostgresType.Timestamptz]: CustomScalar.Timestamptz,
  [PostgresType.Date]: CustomScalar.Date,
  [PostgresType.Time]: CustomScalar.Time,
  [PostgresType.Interval]: CustomScalar.Interval,
  [PostgresType.Json]: CustomScalar.Json,
  [PostgresType.Jsonb]: CustomScalar.Jsonb,
  [PostgresType.Bytea]: CustomScalar.Bytea,
};

// The text types, whose comparisons add the patterns
const TEXT_TYPES: ReadonlySet<PostgresType> = new Set([
  PostgresType.Text,
  PostgresType.Varchar,
  PostgresType.Bpchar,
]);

/**
 * The comparison operators each kind of field offers in a where filter:
 * every scalar and enum has the base set, and text adds patterns
 */
const BASE_OPERATORS = [
  ComparisonOperator.Eq,
  ComparisonOperator.Neq,
  ComparisonOperator.Gt,
  ComparisonOperator.Gte,
  ComparisonOperator.Lt,
  ComparisonOperator.Lte,
  ComparisonOperator.In,
  ComparisonOperator.Nin,
  ComparisonOperator.IsNull,
];
// Materialize has no SIMILAR TO, so there's no _similar or _nsimilar
const PATTERN_OPERATORS = [
  ComparisonOperator.Like,
  ComparisonOperator.Nlike,
  ComparisonOperator.Ilike,
  ComparisonOperator.Nilike,
  ComparisonOperator.Regex,
  ComparisonOperator.Nregex,
  ComparisonOperator.Iregex,
  ComparisonOperator.Niregex,
];
const STRING_OPERATORS = [...BASE_OPERATORS, ...PATTERN_OPERATORS];

/**
 * Builds a comparison input type: each operator takes a value of the field's
 * type, a list of them for set operators, or a boolean for _is_null
 */
function buildComparisonInput(
  name: string,
  valueType: string,
  operators: ComparisonOperator[],
): string {
  const fields = operators
    .map((operator) => {
      switch (operator) {
        case ComparisonOperator.In:
        case ComparisonOperator.Nin:
          return `      ${operator}: [${valueType}!]`;
        case ComparisonOperator.IsNull:
          return `      ${operator}: ${GraphQLBoolean.name}`;
        default:
          return `      ${operator}: ${valueType}`;
      }
    })
    .join('\n');
  return `    input ${name} {\n${fields}\n    }`;
}

/**
 * Generates GraphQL SDL schema from source configuration
 * Creates type definitions for each source including Query, Subscription, and custom types
 */
export function generateSchema(config: SourceConfiguration): string {
  const { sources, enums } = config;

  // Build all the dynamic parts
  const enumTypeDefinitions = buildEnumTypes(enums);
  const enumComparisonTypes = buildEnumComparisonTypes(enums);
  const scalars = scalarsUsed(sources);
  const scalarDeclarations = buildScalarDeclarations(scalars);
  const comparisonTypes = buildComparisonTypes(scalars);
  const expressionInputTypes = buildExpressionInputTypes(sources);
  const orderByInputTypes = buildOrderByInputTypes(sources);
  const sourceTypes = buildSourceTypes(sources);
  const queryFields = buildRootFields(
    sources,
    (sourceName) => `[${sourceName}!]!`,
  );
  const subscriptionFields = buildRootFields(
    sources,
    (sourceName) => `[${updateTypeName(sourceName)}!]!`,
  );

  const schema = `
    # ================== ENUMS & BASE TYPES ==================

    # Row operation types for subscriptions
    enum ${ROW_OPERATION_TYPE} {
      ${GraphQLRowOperation.Insert}
      ${GraphQLRowOperation.Update}
      ${GraphQLRowOperation.Delete}
    }

    # The ways a column can sort
    enum ${ORDER_DIRECTION_TYPE} {
${Object.values(OrderDirection)
  .map((direction) => `      ${direction}`)
  .join('\n')}
    }

    ${enumTypeDefinitions}

${scalarDeclarations}
    
    # ================== INPUT TYPES ==================

${comparisonTypes}

${enumComparisonTypes}

${expressionInputTypes}

${orderByInputTypes}
    
    # ================== OBJECT TYPES ==================
    
${sourceTypes}
    
    # ================== ROOT TYPES ==================
    
    schema {
      query: ${RootType.Query}
      subscription: ${RootType.Subscription}
    }

    # Queries: each source's current rows, once
    type ${RootType.Query} {
${queryFields}
    }
    
    # Subscriptions: each source's current rows, then every change, as one
    # list of updates per timestamp
    type ${RootType.Subscription} {
${subscriptionFields}
    }`;

  return schema;
}

/**
 * Build GraphQL enum type definitions from collected enum types
 */
function buildEnumTypes(enumTypes: Map<string, EnumType>): string {
  if (enumTypes.size === 0) {
    return '';
  }

  const enumDefinitions: string[] = [];

  for (const enumType of enumTypes.values()) {
    const values = enumType.values.map((value) => `      ${value}`).join('\n');
    enumDefinitions.push(`    # User-defined enum: ${enumType.name}
    enum ${enumType.name} {
${values}
    }`);
  }

  return enumDefinitions.join('\n\n');
}

/**
 * Build comparison types for each enum
 * Creates enum-specific comparison input types with ordinal operators
 */
function buildEnumComparisonTypes(enumTypes: Map<string, EnumType>): string {
  if (enumTypes.size === 0) {
    return '';
  }

  const comparisonTypes: string[] = [];

  for (const enumType of enumTypes.values()) {
    const enumName = enumType.name;
    comparisonTypes.push(
      `    # Comparison operators for ${enumName} enum\n` +
        buildComparisonInput(
          comparisonTypeName(enumName),
          enumName,
          BASE_OPERATORS,
        ),
    );
  }

  return comparisonTypes.join('\n\n');
}

/**
 * The scalars the sources' columns use, apart from enums, in a fixed order,
 * each with the operators its comparisons offer: the base set, and for text
 * its patterns too. The schema declares and compares only these.
 */
function scalarsUsed(
  sources: Map<string, SourceDefinition>,
): Map<string, ComparisonOperator[]> {
  const used = new Map<string, ComparisonOperator[]>();
  for (const source of sources.values()) {
    for (const field of source.fields) {
      if (!field.enumType) {
        used.set(
          SCALARS[field.type],
          TEXT_TYPES.has(field.type) ? STRING_OPERATORS : BASE_OPERATORS,
        );
      }
    }
  }
  return new Map([...used].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Declares the scalars that aren't GraphQL's own, such as bigint
 */
function buildScalarDeclarations(
  scalars: Map<string, ComparisonOperator[]>,
): string {
  return [...scalars.keys()]
    .filter((scalar) => CUSTOM_SCALARS.has(scalar))
    .map((scalar) => `    scalar ${scalar}`)
    .join('\n');
}

/**
 * Builds each scalar's comparison input
 */
function buildComparisonTypes(
  scalars: Map<string, ComparisonOperator[]>,
): string {
  return [...scalars]
    .map(([scalar, operators]) =>
      buildComparisonInput(comparisonTypeName(scalar), scalar, operators),
    )
    .join('\n\n');
}

/**
 * Build source types and their update types
 * Creates the object types for each source and their subscription update types
 */
function buildSourceTypes(sources: Map<string, SourceDefinition>): string {
  const types: string[] = [];

  for (const [sourceName, sourceDefinition] of sources) {
    const fields = buildFieldDefinitions(sourceDefinition);

    types.push(`    # ${sourceName} type
    type ${sourceName} {
${fields}
    }
    
    # ${sourceName} update event
    type ${updateTypeName(sourceName)} {
      ${UpdateField.Operation}: ${ROW_OPERATION_TYPE}!
      ${UpdateField.Data}: ${sourceName}
      ${UpdateField.Fields}: [${GraphQLString.name}!]!
    }`);
  }

  return types.join('\n\n');
}

/**
 * Build a root type's fields: one per source, named after it, taking a
 * selection of its rows (where, order_by, limit and offset), and returning
 * the given type
 */
function buildRootFields(
  sources: Map<string, SourceDefinition>,
  returnType: (sourceName: string) => string,
): string {
  return Array.from(sources.keys())
    .map(
      (sourceName) =>
        `      ${sourceName}(` +
        `${RootFieldArgument.Where}: ${boolExpTypeName(sourceName)}, ` +
        `${RootFieldArgument.OrderBy}: [${orderByTypeName(sourceName)}!], ` +
        `${RootFieldArgument.Limit}: ${GraphQLInt.name}, ` +
        `${RootFieldArgument.Offset}: ${GraphQLInt.name}` +
        `): ${returnType(sourceName)}`,
    )
    .join('\n');
}

/**
 * Builds each source's order_by input: each column, and the way it sorts
 */
function buildOrderByInputTypes(
  sources: Map<string, SourceDefinition>,
): string {
  return Array.from(sources.values())
    .map(
      (source) =>
        `    input ${orderByTypeName(source.name)} {\n` +
        source.fields
          .map((field) => `      ${field.name}: ${ORDER_DIRECTION_TYPE}`)
          .join('\n') +
        '\n    }',
    )
    .join('\n\n');
}

/**
 * Build expression input types for all sources
 * Creates expression input types for each source with field comparisons and logical operators
 * Used by subscriptions (where)
 */
function buildExpressionInputTypes(
  sources: Map<string, SourceDefinition>,
): string {
  const inputTypes: string[] = [];

  for (const [sourceName, sourceDefinition] of sources) {
    const fieldComparisons = sourceDefinition.fields
      .map((field) => {
        const comparisonType = getComparisonType(field);
        return `      ${field.name}: ${comparisonType}`;
      })
      .join('\n');

    inputTypes.push(`    # ${sourceName} filter, for its query and subscription
    input ${boolExpTypeName(sourceName)} {
${fieldComparisons}
      ${LogicalOperator.And}: [${boolExpTypeName(sourceName)}!]
      ${LogicalOperator.Or}: [${boolExpTypeName(sourceName)}!]
      ${LogicalOperator.Not}: ${boolExpTypeName(sourceName)}
    }`);
  }

  return inputTypes.join('\n\n');
}

/**
 * Get the appropriate comparison input type for a field
 */
function getComparisonType(field: SourceField): string {
  // Enums use their specific comparison type
  if (field.enumType) {
    return comparisonTypeName(field.enumType.name);
  }

  return comparisonTypeName(SCALARS[field.type]);
}

/**
 * Build field definitions for a source type
 * Maps source fields to GraphQL fields with appropriate types and nullability
 */
function buildFieldDefinitions(sourceDefinition: SourceDefinition): string {
  return sourceDefinition.fields
    .map((field) => {
      // Use enum type if this field has one, otherwise use scalar type
      const graphqlTypeName = field.enumType
        ? field.enumType.name
        : SCALARS[field.type];
      const nullable =
        field.name !== sourceDefinition.primaryKeyField ? '' : '!';
      return `      ${field.name}: ${graphqlTypeName}${nullable}`;
    })
    .join('\n');
}
