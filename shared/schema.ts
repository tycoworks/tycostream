import { readFileSync } from 'fs';
import { join } from 'path';
import { load } from 'js-yaml';
import type { YamlSchemaConfig, LoadedSchema, SchemaField } from './types.js';

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
  
  // Extract fields and find primary key
  const fields: SchemaField[] = [];
  let primaryKeyField: string | null = null;
  
  for (const [fieldName, fieldType] of Object.entries(viewConfig.columns)) {
    const nullable = !fieldType.endsWith('!');
    const cleanType = fieldType.replace('!', '');
    const isPrimaryKey = !primaryKeyField && !nullable; // First non-nullable field is primary key
    
    if (isPrimaryKey) {
      primaryKeyField = fieldName;
    }
    
    fields.push({
      name: fieldName,
      type: cleanType,
      nullable,
      isPrimaryKey,
    });
  }
  
  if (!primaryKeyField) {
    throw new Error('Schema must contain at least one non-nullable field (ending with !) to serve as primary key');
  }
  
  // Generate GraphQL schema
  const typeFields = Object.entries(viewConfig.columns)
    .map(([fieldName, fieldType]) => `  ${fieldName}: ${fieldType}`)
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

