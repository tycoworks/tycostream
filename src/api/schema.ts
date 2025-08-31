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
  // Build all the dynamic parts
  const comparisonTypes = buildComparisonTypes();
  const filterInputTypes = buildFilterInputTypes(sources);
  const triggerInputTypes = buildTriggerInputTypes(sources);
  const sourceTypes = buildSourceTypes(sources);
  const queryFields = buildQueryFields(sources);
  const mutationFields = buildMutationFields(sources);
  const subscriptionFields = buildSubscriptionFields(sources);
  
  let schema = `
    # ================== ENUMS & BASE TYPES ==================
    
    # Row operation types for subscriptions
    enum RowOperation {
      ${GraphQLRowOperation.INSERT}
      ${GraphQLRowOperation.UPDATE}
      ${GraphQLRowOperation.DELETE}
    }
    
    # Trigger type (returned by queries and mutations)
    type Trigger {
      name: ${GraphQLString.name}!
      webhook: ${GraphQLString.name}!
      match: ${GraphQLString.name}!
      unmatch: ${GraphQLString.name}
    }
    
    # ================== INPUT TYPES ==================
    
${comparisonTypes}
    
${filterInputTypes}
    
${triggerInputTypes}
    
    # ================== OBJECT TYPES ==================
    
${sourceTypes}
    
    # ================== ROOT TYPES ==================
    
    # Queries
    type Query {
${queryFields}
    }
    
    # Mutations
    type Mutation {
${mutationFields}
    }
    
    # Subscriptions
    type Subscription {
${subscriptionFields}
    }`;

  return schema;
}

/**
 * Build comparison types for filtering
 * Creates comparison input types for different data types
 */
function buildComparisonTypes(): string {
  return `    # Comparison operators
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
    }`;
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
 * Build query fields for triggers
 * Creates query fields for listing and getting triggers per source
 */
function buildQueryFields(sources: Map<string, SourceDefinition>): string {
  const fields: string[] = [];
  
  for (const sourceName of sources.keys()) {
    fields.push(`      ${sourceName}_triggers: [Trigger!]!`);
    fields.push(`      ${sourceName}_trigger(name: ${GraphQLString.name}!): Trigger`);
  }
  
  return fields.join('\n');
}

/**
 * Build mutation fields for triggers
 * Creates mutation fields for creating and deleting triggers per source
 */
function buildMutationFields(sources: Map<string, SourceDefinition>): string {
  const fields: string[] = [];
  
  for (const sourceName of sources.keys()) {
    fields.push(`      create_${sourceName}_trigger(input: ${sourceName}TriggerInput!): Trigger!`);
    fields.push(`      delete_${sourceName}_trigger(name: ${GraphQLString.name}!): Trigger!`);
  }
  
  return fields.join('\n');
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
 * Build filter input types for all sources
 * Creates filter input types for each source with field comparisons and logical operators
 * Used by both subscriptions (where) and triggers (match/unmatch)
 */
function buildFilterInputTypes(sources: Map<string, SourceDefinition>): string {
  const inputTypes: string[] = [];
  
  for (const [sourceName, sourceDefinition] of sources) {
    const fieldComparisons = sourceDefinition.fields
      .map(field => {
        const comparisonType = getComparisonType(field.type);
        return `      ${field.name}: ${comparisonType}`;
      })
      .join('\n');
    
    inputTypes.push(`    # ${sourceName} filter conditions (for subscriptions and triggers)
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
 * Build trigger input types for all sources
 * Creates input types for creating triggers for each source
 */
function buildTriggerInputTypes(sources: Map<string, SourceDefinition>): string {
  const inputTypes: string[] = [];
  
  for (const sourceName of sources.keys()) {
    inputTypes.push(`    # ${sourceName} trigger input
    input ${sourceName}TriggerInput {
      name: ${GraphQLString.name}!
      webhook: ${GraphQLString.name}!
      match: ${sourceName}Where!
      unmatch: ${sourceName}Where
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