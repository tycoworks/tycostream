import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import type { YamlSchemaConfig, LoadedSchema, SchemaField } from './types.js';
import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLString, GraphQLID } from 'graphql';
import pgTypes from 'pg-types';
// @ts-ignore - no type definitions available for pg-type-names
import pgTypeNamesModule from 'pg-type-names';
// Handle both ESM and CommonJS exports
const pgTypeNames = (pgTypeNamesModule as any)?.default || pgTypeNamesModule;

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
 * Load complete schema from YAML configuration
 */
export function loadSchemaFromYaml(configDir: string): LoadedSchema {
  const schemaPath = join(configDir, 'schema.yaml');
  
  // Load and parse YAML file
  let yamlConfig: YamlSchemaConfig;
  try {
    const yamlContent = readFileSync(schemaPath, 'utf-8');
    const parsed = load(yamlContent) as YamlSchemaConfig;
    
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid YAML schema format');
    }
    
    if (!parsed.views || typeof parsed.views !== 'object') {
      throw new Error('YAML schema must contain a "views" section');
    }
    
    yamlConfig = parsed;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Schema file not found at ${schemaPath}. Create a schema.yaml file in the config directory.`);
    }
    throw error;
  }
  
  // Validate exactly one view
  const views = Object.entries(yamlConfig.views);
  if (views.length === 0) {
    throw new Error('YAML schema must contain at least one view definition');
  }
  if (views.length > 1) {
    throw new Error('Only one view definition is supported in the current version');
  }
  
  const [graphqlTypeName, viewConfig] = views[0]!;
  const databaseViewName = viewConfig.view;
  
  // Validate primary_key is present
  if (!viewConfig.primary_key) {
    throw new Error('Schema must contain a primary_key attribute');
  }
  
  // Extract fields and validate primary key
  const fields: SchemaField[] = [];
  const primaryKeyField = viewConfig.primary_key;
  
  // Validate primary key exists in columns
  if (!viewConfig.columns[primaryKeyField]) {
    throw new Error(`Primary key field '${primaryKeyField}' not found in columns`);
  }
  
  for (const [fieldName, postgresType] of Object.entries(viewConfig.columns)) {
    const isPrimaryKey = fieldName === primaryKeyField;
    
    // Map Postgres type to GraphQL type
    const oid = pgTypeNames.oids[postgresType];
    if (!oid) {
      throw new Error(`Unknown PostgreSQL type: ${postgresType}`);
    }
    
    const graphqlType = TYPE_MAP[oid as keyof typeof TYPE_MAP];
    if (!graphqlType) {
      throw new Error(`No GraphQL mapping for PostgreSQL type: ${postgresType}`);
    }
    
    const graphqlTypeName = graphqlType.name;
    
    fields.push({
      name: fieldName,
      type: graphqlTypeName,
      nullable: !isPrimaryKey, // Primary key is always non-nullable
      isPrimaryKey,
    });
  }
  
  // Generate GraphQL schema
  const typeFields = fields
    .map(field => {
      const type = field.nullable ? field.type : `${field.type}!`;
      return `  ${field.name}: ${type}`;
    })
    .join('\n');
  
  const typeDefs = `type ${graphqlTypeName} {
${typeFields}
}

type Query {
  # Current snapshot of ${graphqlTypeName} data
  ${graphqlTypeName}: [${graphqlTypeName}!]!
}

type Subscription {
  ${graphqlTypeName}: ${graphqlTypeName}!
}`;
  
  // Debug log the generated schema if debug level is enabled
  if (process.env.LOG_LEVEL === 'debug') {
    console.log('Generated GraphQL schema from YAML:', {
      graphqlTypeName,
      databaseViewName,
      primaryKeyField,
      fieldsCount: fields.length,
      typeDefs: typeDefs.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
    });
  }
  
  return {
    typeDefs,
    fields,
    primaryKeyField,
    viewName: graphqlTypeName,
    databaseViewName,
  };
}

