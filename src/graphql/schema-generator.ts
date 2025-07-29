import type { SourceDefinition } from '../config/source-definition.types';
import { getGraphQLType } from '../common/type-map';
import { GraphQLRowOperation } from './subscription-resolvers';

/**
 * Generates GraphQL SDL schema from source definitions
 */
export function generateSchema(sources: Map<string, SourceDefinition>): string {
  const subscriptionFields = buildSubscriptionFields(sources);
  
  let schema = `
    # Basic query (required by GraphQL)
    type Query {
      ping: String
    }
    
    # Row operation types
    enum RowOperation {
      ${GraphQLRowOperation.INSERT}
      ${GraphQLRowOperation.UPDATE}
      ${GraphQLRowOperation.DELETE}
    }
    
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
      fields: [String!]! 
    }`;
  }

  return schema;
}

/**
 * Build subscription fields for all sources
 */
function buildSubscriptionFields(sources: Map<string, SourceDefinition>): string {
  return Array.from(sources.keys())
    .map(sourceName => `      ${sourceName}: ${sourceName}Update!`)
    .join('\n');
}

/**
 * Build field definitions for a source type
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