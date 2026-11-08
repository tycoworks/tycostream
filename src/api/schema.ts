import type {
  SourceDefinition,
  SourceField,
  EnumType,
  SourceConfiguration,
} from '../config/source.types.js';
import {
  ComparisonOperator,
  DataType,
  LogicalOperator,
} from '../common/types.js';
import { GraphQLRowOperation } from './api.service.js';
import {
  GraphQLString,
  GraphQLInt,
  GraphQLFloat,
  GraphQLBoolean,
  GraphQLID,
} from 'graphql';
import type { GraphQLScalarType } from 'graphql';

/**
 * Comparison input type names for GraphQL schema
 */
enum ComparisonInputType {
  String = 'StringComparison',
  Int = 'IntComparison',
  Float = 'FloatComparison',
  Boolean = 'BooleanComparison',
}

/**
 * The comparison operators each kind of field offers in a where filter
 */
const EQUALITY_OPERATORS = [
  ComparisonOperator.Eq,
  ComparisonOperator.Neq,
  ComparisonOperator.IsNull,
];
const SET_OPERATORS = [ComparisonOperator.In, ComparisonOperator.Nin];
const ORDERING_OPERATORS = [
  ComparisonOperator.Gt,
  ComparisonOperator.Gte,
  ComparisonOperator.Lt,
  ComparisonOperator.Lte,
];
const BOOLEAN_OPERATORS = EQUALITY_OPERATORS;
const STRING_OPERATORS = [...EQUALITY_OPERATORS, ...SET_OPERATORS];
const ORDERED_OPERATORS = [
  ...EQUALITY_OPERATORS,
  ...ORDERING_OPERATORS,
  ...SET_OPERATORS,
];

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
  const comparisonTypes = buildComparisonTypes();
  const expressionInputTypes = buildExpressionInputTypes(sources);
  const sourceTypes = buildSourceTypes(sources);
  const queryFields = buildRootFields(
    sources,
    (sourceName) => `[${sourceName}!]!`,
  );
  const subscriptionFields = buildRootFields(
    sources,
    (sourceName) => `${sourceName}Update!`,
  );

  const schema = `
    # ================== ENUMS & BASE TYPES ==================

    # Row operation types for subscriptions
    enum RowOperation {
      ${GraphQLRowOperation.Insert}
      ${GraphQLRowOperation.Update}
      ${GraphQLRowOperation.Delete}
    }

    ${enumTypeDefinitions}
    
    # ================== INPUT TYPES ==================

${comparisonTypes}

${enumComparisonTypes}

${expressionInputTypes}
    
    # ================== OBJECT TYPES ==================
    
${sourceTypes}
    
    # ================== ROOT TYPES ==================
    
    # Queries: each source's current rows, once
    type Query {
${queryFields}
    }
    
    # Subscriptions: each source's current rows, then every change
    type Subscription {
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
          `${enumName}Comparison`,
          enumName,
          ORDERED_OPERATORS,
        ),
    );
  }

  return comparisonTypes.join('\n\n');
}

/**
 * Build comparison types for filtering
 * Creates comparison input types for different data types
 */
function buildComparisonTypes(): string {
  return [
    `    # Comparison operators\n` +
      buildComparisonInput(
        ComparisonInputType.String,
        GraphQLString.name,
        STRING_OPERATORS,
      ),
    buildComparisonInput(
      ComparisonInputType.Int,
      GraphQLInt.name,
      ORDERED_OPERATORS,
    ),
    buildComparisonInput(
      ComparisonInputType.Float,
      GraphQLFloat.name,
      ORDERED_OPERATORS,
    ),
    buildComparisonInput(
      ComparisonInputType.Boolean,
      GraphQLBoolean.name,
      BOOLEAN_OPERATORS,
    ),
  ].join('\n\n');
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
    type ${sourceName}Update {
      operation: RowOperation!
      data: ${sourceName}
      fields: [${GraphQLString.name}!]!
    }`);
  }

  return types.join('\n\n');
}

/**
 * Build a root type's fields: one per source, named after it, filtered by
 * its expression, and returning the given type
 */
function buildRootFields(
  sources: Map<string, SourceDefinition>,
  returnType: (sourceName: string) => string,
): string {
  return Array.from(sources.keys())
    .map(
      (sourceName) =>
        `      ${sourceName}(where: ${sourceName}Expression): ${returnType(sourceName)}`,
    )
    .join('\n');
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

    inputTypes.push(`    # ${sourceName} expression conditions (for subscriptions)
    input ${sourceName}Expression {
${fieldComparisons}
      ${LogicalOperator.And}: [${sourceName}Expression!]
      ${LogicalOperator.Or}: [${sourceName}Expression!]
      ${LogicalOperator.Not}: ${sourceName}Expression
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
    return `${field.enumType.name}Comparison`;
  }

  const graphqlTypeName = getGraphQLScalarType(field.dataType).name;
  switch (graphqlTypeName) {
    case GraphQLString.name:
    case GraphQLID.name:
      return ComparisonInputType.String;
    case GraphQLInt.name:
      return ComparisonInputType.Int;
    case GraphQLFloat.name:
      return ComparisonInputType.Float;
    case GraphQLBoolean.name:
      return ComparisonInputType.Boolean;
    default:
      // Any other types (shouldn't happen with our current type mappings)
      return ComparisonInputType.String;
  }
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
        : getGraphQLScalarType(field.dataType).name;
      const nullable =
        field.name !== sourceDefinition.primaryKeyField ? '' : '!';
      return `      ${field.name}: ${graphqlTypeName}${nullable}`;
    })
    .join('\n');
}

/**
 * Get the GraphQL scalar type for a runtime type
 * Maps our internal DataType to GraphQL scalar types
 */
function getGraphQLScalarType(dataType: DataType): GraphQLScalarType {
  switch (dataType) {
    // Numeric types
    case DataType.Integer:
      return GraphQLInt;
    case DataType.Float:
      return GraphQLFloat;
    case DataType.BigInt:
      return GraphQLString; // BigInt as string to preserve precision

    // String types
    case DataType.String:
      return GraphQLString;
    case DataType.UUID:
      return GraphQLID;

    // Temporal types (all as strings)
    case DataType.Timestamp:
    case DataType.Date:
    case DataType.Time:
      return GraphQLString;

    // Other types
    case DataType.Boolean:
      return GraphQLBoolean;
    case DataType.JSON:
    case DataType.Array:
      return GraphQLString; // JSON/Arrays as strings

    default:
      // Fallback to string
      return GraphQLString;
  }
}
