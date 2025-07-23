import type { SourceDefinition } from '../config/source-definition.types';
import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLString, GraphQLID } from 'graphql';
import * as pgTypes from 'pg-types';

// pg-type-names doesn't have type definitions, but we only use the oids property
const pgTypeNamesModule = require('pg-type-names');
const pgTypeNames = pgTypeNamesModule.default || pgTypeNamesModule;
const typeOids = pgTypeNames.oids as Record<string, number>;

/**
 * Maps PostgreSQL OIDs to GraphQL scalar types
 * Using the same approach as the original codebase
 */
const TYPE_MAP = {
  [pgTypes.builtins.BOOL]: GraphQLBoolean,
  [pgTypes.builtins.INT8]: GraphQLFloat, // GraphQL Int is 32-bit, bigint needs Float
  [pgTypes.builtins.INT2]: GraphQLInt,
  [pgTypes.builtins.INT4]: GraphQLInt,
  [pgTypes.builtins.TEXT]: GraphQLString,
  [pgTypes.builtins.FLOAT4]: GraphQLFloat,
  [pgTypes.builtins.FLOAT8]: GraphQLFloat,
  [pgTypes.builtins.NUMERIC]: GraphQLFloat,
  [pgTypes.builtins.UUID]: GraphQLID,
  [pgTypes.builtins.TIMESTAMP]: GraphQLString,
  [pgTypes.builtins.TIMESTAMPTZ]: GraphQLString,
  [pgTypes.builtins.DATE]: GraphQLString,
  [pgTypes.builtins.TIME]: GraphQLString,
  [pgTypes.builtins.JSON]: GraphQLString,
  [pgTypes.builtins.JSONB]: GraphQLString,
} as const;

/**
 * Get GraphQL SDL type name for a PostgreSQL type name
 */
function getGraphQLSDLType(pgTypeName: string): string {
  const oid = typeOids[pgTypeName];
  if (!oid) {
    return GraphQLString.name; // Default to String for unknown types
  }
  const graphqlType = TYPE_MAP[oid];
  if (!graphqlType) {
    return GraphQLString.name;
  }
  // JSON/JSONB need custom scalar
  if (pgTypeName === 'json' || pgTypeName === 'jsonb') {
    return 'JSON';
  }
  return graphqlType.name;
}

/**
 * Generates GraphQL SDL schema from source definitions
 */
export function generateSchema(sources: Map<string, SourceDefinition>): string {
  let hasJsonFields = false;
  
  // Check if any source has JSON/JSONB fields
  for (const [, sourceDefinition] of sources) {
    if (sourceDefinition.fields.some(f => f.type === 'json' || f.type === 'jsonb')) {
      hasJsonFields = true;
      break;
    }
  }
  
  let sdl = `
    # Basic query (required by GraphQL)
    type Query {
      ping: String
    }
    
    # Row operation types
    enum RowOperation {
      INSERT
      UPDATE
      DELETE
    }`;
  
  // Only add JSON scalar if needed
  if (hasJsonFields) {
    sdl += `
    
    # JSON scalar for JSON/JSONB fields
    scalar JSON`;
  }
  
  // Add base subscription type
  sdl += `
    
    type Subscription {`;
  
  // Add all subscription fields first
  for (const [sourceName] of sources) {
    sdl += `
      ${sourceName}: ${sourceName}Update!`;
  }
  
  sdl += `
    }`;

  // Generate types for each source
  for (const [sourceName, sourceDefinition] of sources) {
    // Build fields string
    const fields = sourceDefinition.fields
      .map(field => {
        const graphqlType = getGraphQLSDLType(field.type);
        const nullable = field.name !== sourceDefinition.primaryKeyField ? '' : '!';
        return `      ${field.name}: ${graphqlType}${nullable}`;
      })
      .join('\n');
    
    // Add type definitions for this source
    sdl += `

    # ${sourceName} type
    type ${sourceName} {
${fields}
    }

    # ${sourceName} update event
    type ${sourceName}Update {
      operation: RowOperation!
      data: ${sourceName}
    }`;
  }

  return sdl;
}