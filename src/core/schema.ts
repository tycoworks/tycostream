import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import { GraphQLBoolean, GraphQLFloat, GraphQLInt, GraphQLString, GraphQLID } from 'graphql';

// Schema types
export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

// Schema for a single view
export interface ViewSchema {
  typeDefs: string;
  fields: SchemaField[];
  primaryKeyField: string;
  viewName: string; // GraphQL type name
  databaseViewName: string; // Database view name
}

// Schema for the entire application (may contain multiple views)
export interface LoadedSchema {
  views: Map<string, ViewSchema>;
  typeDefs: string;
}

// YAML schema configuration types
export interface YamlViewConfig {
  view: string;
  primary_key: string;
  columns: Record<string, string>;
}

export interface YamlSchemaConfig {
  views: Record<string, YamlViewConfig>;
}
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
  
  // Validate at least one view
  const views = Object.entries(yamlConfig.views);
  if (views.length === 0) {
    throw new Error('YAML schema must contain at least one view definition');
  }
  
  const loadedViews = new Map<string, ViewSchema>();
  const typeDefsList: string[] = [];
  
  for (const [graphqlTypeName, viewConfig] of views) {
    const databaseViewName = viewConfig.view;
  
    // Validate primary_key is present
    if (!viewConfig.primary_key) {
      throw new Error(`View '${graphqlTypeName}' must contain a primary_key attribute`);
    }
  
    // Extract fields and validate primary key
    const fields: SchemaField[] = [];
    const primaryKeyField = viewConfig.primary_key;
  
    // Validate primary key exists in columns
    if (!viewConfig.columns[primaryKeyField]) {
      throw new Error(`Primary key field '${primaryKeyField}' not found in columns for view '${graphqlTypeName}'`);
    }
  
    // Validate primary key type is supported
    const primaryKeyType = viewConfig.columns[primaryKeyField];
    const supportedPrimaryKeyTypes = ['integer', 'bigint', 'text', 'varchar', 'uuid'];
    if (!supportedPrimaryKeyTypes.includes(primaryKeyType)) {
      throw new Error(`Primary key type '${primaryKeyType}' is not supported for view '${graphqlTypeName}'. Supported types: ${supportedPrimaryKeyTypes.join(', ')}`);
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
  
    // Generate GraphQL schema for this view
    const typeFields = fields
      .map(field => {
        const type = field.nullable ? field.type : `${field.type}!`;
        return `  ${field.name}: ${type}`;
      })
      .join('\n');
    
    const typeDef = `type ${graphqlTypeName} {
${typeFields}
}`;
    
    typeDefsList.push(typeDef);
    
    // Store loaded schema for this view
    loadedViews.set(graphqlTypeName, {
      typeDefs: typeDef,
      fields,
      primaryKeyField,
      viewName: graphqlTypeName,
      databaseViewName,
    });
    
    // Debug log the generated schema if debug level is enabled
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('Generated GraphQL schema from YAML:', {
        graphqlTypeName,
        databaseViewName,
        primaryKeyField,
        fieldsCount: fields.length,
        typeDef: typeDef.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      });
    }
  }
  
  // Generate combined Query and Subscription types
  const queryFields = Array.from(loadedViews.entries())
    .map(([typeName]) => `  # Current snapshot of ${typeName} data\n  ${typeName}: [${typeName}!]!`)
    .join('\n');
    
  const subscriptionFields = Array.from(loadedViews.entries())
    .map(([typeName]) => `  ${typeName}: ${typeName}!`)
    .join('\n');
  
  const typeDefs = `${typeDefsList.join('\n\n')}

type Query {
${queryFields}
}

type Subscription {
${subscriptionFields}
}`;
  
  return {
    views: loadedViews,
    typeDefs,
  };
}

