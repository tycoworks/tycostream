import type { SourceDefinition } from '../config/source.types';
import { getGraphQLType } from '../common/types';
import { GraphQLRowOperation } from './subscription.resolver';
import { GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID } from 'graphql';

/**
 * Comparison input type names for GraphQL schema
 */
enum ComparisonInputType {
  String = 'StringComparison',
  Int = 'IntComparison',
  Float = 'FloatComparison',
  Boolean = 'BooleanComparison'
}

/**
 * Generates GraphQL SDL schema from source definitions
 * Creates type definitions for each source including Query, Subscription, and custom types
 */
export function generateSchema(sources: Map<string, SourceDefinition>): string {
  const subscriptionFields = buildSubscriptionFields(sources);
  const whereInputTypes = buildWhereInputTypes(sources);
  
  let schema = `
    # Basic query (required by GraphQL)
    type Query {
      ping: ${GraphQLString.name}
    }
    
    # Row operation types
    enum RowOperation {
      ${GraphQLRowOperation.INSERT}
      ${GraphQLRowOperation.UPDATE}
      ${GraphQLRowOperation.DELETE}
    }
    
    # Comparison operators
    input StringComparison {
      _eq: ${GraphQLString.name}
      _neq: ${GraphQLString.name}
      _in: [${GraphQLString.name}!]
      _nin: [${GraphQLString.name}!]
      _is_null: ${GraphQLBoolean.name}
    }
    
    input IntComparison {
      _eq: ${GraphQLInt.name}
      _neq: ${GraphQLInt.name}
      _gt: ${GraphQLInt.name}
      _lt: ${GraphQLInt.name}
      _gte: ${GraphQLInt.name}
      _lte: ${GraphQLInt.name}
      _in: [${GraphQLInt.name}!]
      _nin: [${GraphQLInt.name}!]
      _is_null: ${GraphQLBoolean.name}
    }
    
    input FloatComparison {
      _eq: ${GraphQLFloat.name}
      _neq: ${GraphQLFloat.name}
      _gt: ${GraphQLFloat.name}
      _lt: ${GraphQLFloat.name}
      _gte: ${GraphQLFloat.name}
      _lte: ${GraphQLFloat.name}
      _in: [${GraphQLFloat.name}!]
      _nin: [${GraphQLFloat.name}!]
      _is_null: ${GraphQLBoolean.name}
    }
    
    input BooleanComparison {
      _eq: ${GraphQLBoolean.name}
      _neq: ${GraphQLBoolean.name}
      _is_null: ${GraphQLBoolean.name}
    }
    
${whereInputTypes}
    
    type Subscription {
${subscriptionFields}
    }`;

  // Add types for each source
  for (const [sourceName, sourceDefinition] of sources) {
    const fields = buildFieldDefinitions(sourceDefinition);
    
    schema += `

    # ${sourceName} type
    type ${sourceName} {
${fields}
    }

    # ${sourceName} update event
    type ${sourceName}Update {
      operation: RowOperation!
      data: ${sourceName}
      fields: [${GraphQLString.name}!]! 
    }`;
  }

  return schema;
}

/**
 * Build subscription fields for all sources
 * Creates a subscription field for each source that returns its update type
 */
function buildSubscriptionFields(sources: Map<string, SourceDefinition>): string {
  return Array.from(sources.keys())
    .map(sourceName => `      ${sourceName}(where: ${sourceName}Where): ${sourceName}Update!`)
    .join('\n');
}

/**
 * Build where input types for all sources
 * Creates a where input type for each source with field comparisons and logical operators
 */
function buildWhereInputTypes(sources: Map<string, SourceDefinition>): string {
  const inputTypes: string[] = [];
  
  for (const [sourceName, sourceDefinition] of sources) {
    const fieldComparisons = sourceDefinition.fields
      .map(field => {
        const comparisonType = getComparisonType(field.type);
        return `      ${field.name}: ${comparisonType}`;
      })
      .join('\n');
    
    inputTypes.push(`    # ${sourceName} where conditions
    input ${sourceName}Where {
${fieldComparisons}
      _and: [${sourceName}Where!]
      _or: [${sourceName}Where!]
      _not: ${sourceName}Where
    }`);
  }
  
  return inputTypes.join('\n\n');
}

/**
 * Get the appropriate comparison input type for a field type
 */
function getComparisonType(fieldType: string): ComparisonInputType {
  const graphqlType = getGraphQLType(fieldType);
  
  switch (graphqlType) {
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
    .map(field => {
      const graphqlType = getGraphQLType(field.type);
      const nullable = field.name !== sourceDefinition.primaryKeyField ? '' : '!';
      return `      ${field.name}: ${graphqlType}${nullable}`;
    })
    .join('\n');
}