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

// Schema for a single source
export interface SourceSchema {
  typeDefs: string;
  fields: SchemaField[];
  primaryKeyField: string;
  sourceName: string; // Both database source name and GraphQL subscription name
}

// Schema for the entire application
export interface LoadedSchema {
  sources: Map<string, SourceSchema>;
  typeDefs: string;
}

// YAML schema configuration types
export interface YamlSourceConfig {
  primary_key: string;
  columns: Record<string, string>;
}

export interface YamlSchemaConfig {
  sources: Record<string, YamlSourceConfig>;
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
    
    if (!parsed.sources || typeof parsed.sources !== 'object') {
      throw new Error('YAML schema must contain a "sources" section');
    }
    
    yamlConfig = parsed;
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Schema file not found at ${schemaPath}. Create a schema.yaml file in the config directory.`);
    }
    throw error;
  }
  
  // Validate at least one source
  const sources = Object.entries(yamlConfig.sources);
  if (sources.length === 0) {
    throw new Error('YAML schema must contain at least one source definition');
  }
  
  const loadedSources = new Map<string, SourceSchema>();
  const typeDefsList: string[] = [];
  
  for (const [sourceName, sourceConfig] of sources) {
  
    // Validate primary_key is present
    if (!sourceConfig.primary_key) {
      throw new Error(`Source '${sourceName}' must contain a primary_key attribute`);
    }
  
    // Extract fields and validate primary key
    const fields: SchemaField[] = [];
    const primaryKeyField = sourceConfig.primary_key;
  
    // Validate primary key exists in columns
    if (!sourceConfig.columns[primaryKeyField]) {
      throw new Error(`Primary key field '${primaryKeyField}' not found in columns for source '${sourceName}'`);
    }
  
    // Validate primary key type is supported
    const primaryKeyType = sourceConfig.columns[primaryKeyField];
    const supportedPrimaryKeyTypes = ['integer', 'bigint', 'text', 'varchar', 'uuid'];
    if (!supportedPrimaryKeyTypes.includes(primaryKeyType)) {
      throw new Error(`Primary key type '${primaryKeyType}' is not supported for source '${sourceName}'. Supported types: ${supportedPrimaryKeyTypes.join(', ')}`);
    }
  
    for (const [fieldName, postgresType] of Object.entries(sourceConfig.columns)) {
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
    
    const typeDef = `type ${sourceName} {
${typeFields}
}`;
    
    typeDefsList.push(typeDef);
    
    // Store loaded schema for this source
    loadedSources.set(sourceName, {
      typeDefs: typeDef,
      fields,
      primaryKeyField,
      sourceName,
    });
    
    // Debug log the generated schema if debug level is enabled
    if (process.env.LOG_LEVEL === 'debug') {
      console.log('Generated GraphQL schema from YAML:', {
        sourceName,
        primaryKeyField,
        fieldsCount: fields.length,
        typeDef: typeDef.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim()
      });
    }
  }
  
  // Generate combined Subscription type
  const subscriptionFields = Array.from(loadedSources.entries())
    .map(([sourceName]) => `  ${sourceName}: ${sourceName}!`)
    .join('\n');
  
  const typeDefs = `${typeDefsList.join('\n\n')}

# Minimal Query type required by GraphQL spec
type Query {
  _empty: String
}

type Subscription {
${subscriptionFields}
}`;
  
  return {
    sources: loadedSources,
    typeDefs,
  };
}

