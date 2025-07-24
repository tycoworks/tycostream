import { GraphQLScalarType, GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLString, GraphQLID } from 'graphql';
import * as pgTypes from 'pg-types';

// PostgreSQL type name to OID mapping (from pg-type-names)
const pgTypeNamesModule = require('pg-type-names');
const pgTypeNames = pgTypeNamesModule.default || pgTypeNamesModule;

/**
 * PostgreSQL OID to GraphQL type mapping
 * Pure data structure - no behavior
 */
export const TYPE_MAP: Record<number, GraphQLScalarType> = {
  [pgTypes.builtins.BOOL]: GraphQLBoolean,
  [pgTypes.builtins.INT2]: GraphQLInt,
  [pgTypes.builtins.INT4]: GraphQLInt,
  [pgTypes.builtins.INT8]: GraphQLString, // String to preserve precision
  [pgTypes.builtins.FLOAT4]: GraphQLFloat,
  [pgTypes.builtins.FLOAT8]: GraphQLFloat,
  [pgTypes.builtins.NUMERIC]: GraphQLFloat,
  [pgTypes.builtins.TEXT]: GraphQLString,
  [pgTypes.builtins.VARCHAR]: GraphQLString,
  [pgTypes.builtins.CHAR]: GraphQLString,
  [pgTypes.builtins.BPCHAR]: GraphQLString, // "blank padded char" - PostgreSQL's internal name for CHAR
  [pgTypes.builtins.UUID]: GraphQLID,
  [pgTypes.builtins.TIMESTAMP]: GraphQLString,
  [pgTypes.builtins.TIMESTAMPTZ]: GraphQLString,
  [pgTypes.builtins.DATE]: GraphQLString,
  [pgTypes.builtins.TIME]: GraphQLString,
  [pgTypes.builtins.TIMETZ]: GraphQLString, // Time with timezone
  [pgTypes.builtins.JSON]: GraphQLString,
  [pgTypes.builtins.JSONB]: GraphQLString,
} as const;

/**
 * Get PostgreSQL type OID from type name
 * Throws error for unsupported types
 */
export function getPostgresType(typeName: string): number {
  const oid = pgTypeNames.oids[typeName];
  if (!oid) {
    throw new Error(`Unsupported PostgreSQL type: ${typeName}`);
  }
  
  // Check if we have a GraphQL mapping for this OID
  if (!TYPE_MAP[oid]) {
    throw new Error(`PostgreSQL type '${typeName}' is not supported by tycostream`);
  }
  
  return oid;
}

/**
 * Get GraphQL type name for a PostgreSQL type
 * Returns the GraphQL type name (e.g., "String", "Int", "Boolean")
 */
export function getGraphQLType(typeName: string): string {
  const oid = getPostgresType(typeName);
  const graphqlType = TYPE_MAP[oid];
  return graphqlType ? graphqlType.name : GraphQLString.name;
}

