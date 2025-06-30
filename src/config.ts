import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { DatabaseConfig, LoadedSchema, SchemaField } from '../shared/types.js';

export class ConfigError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadDatabaseConfig(): DatabaseConfig {
  const requiredEnvVars = {
    SOURCE_HOST: process.env.SOURCE_HOST,
    SOURCE_PORT: process.env.SOURCE_PORT,
    SOURCE_USER: process.env.SOURCE_USER,
    SOURCE_PASSWORD: process.env.SOURCE_PASSWORD,
    SOURCE_DB: process.env.SOURCE_DB,
    VIEW_NAME: process.env.VIEW_NAME,
  };

  for (const [key, value] of Object.entries(requiredEnvVars)) {
    if (!value || value.trim() === '') {
      throw new ConfigError(
        `Missing required environment variable: ${key}. ` +
        `Please set ${key} in your environment or .env file. ` +
        `Example: ${key}=${getExampleValue(key)}`,
        key
      );
    }
  }

  const port = parseInt(requiredEnvVars.SOURCE_PORT!, 10);
  if (isNaN(port) || port <= 0 || port > 65535) {
    throw new ConfigError(
      `SOURCE_PORT must be a valid port number (1-65535). ` +
      `Received: "${requiredEnvVars.SOURCE_PORT}". ` +
      `Example: SOURCE_PORT=6875`,
      'SOURCE_PORT'
    );
  }

  return {
    host: requiredEnvVars.SOURCE_HOST!,
    port,
    user: requiredEnvVars.SOURCE_USER!,
    password: requiredEnvVars.SOURCE_PASSWORD!,
    database: requiredEnvVars.SOURCE_DB!,
    viewName: requiredEnvVars.VIEW_NAME!,
  };
}

function findProjectRoot(): string {
  // In Docker, we're in /app, schemas are in /app/schema
  // In local dev, we're in project root, schemas are in ./schema
  
  const schemaPath = join(process.cwd(), 'schema');
  
  // Check if schema directory exists
  try {
    if (existsSync(schemaPath)) {
      return schemaPath;
    }
  } catch {
    // Continue with default
  }
  
  // Default to schema directory
  return schemaPath;
}

export function loadSchema(viewName: string): LoadedSchema {
  const schemaDir = findProjectRoot();
  const schemaPath = join(schemaDir, `${viewName}.sdl`);
  
  let typeDefs: string;
  try {
    typeDefs = readFileSync(schemaPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `Schema file not found: ${schemaPath}. ` +
        `Please create a GraphQL schema file at this location. ` +
        `The schema must define types and a Subscription with field '${viewName}'. ` +
        `Example schema structure can be found in the documentation.`,
        'SCHEMA_FILE'
      );
    }
    throw new ConfigError(
      `Failed to read schema file: ${(error as Error).message}. ` +
      `Please check file permissions and syntax at: ${schemaPath}`,
      'SCHEMA_FILE'
    );
  }

  if (!typeDefs || typeDefs.trim() === '') {
    throw new ConfigError('Schema file is empty', 'SCHEMA_FILE');
  }

  const fields = parseSchemaFields(typeDefs);
  const primaryKeyField = findPrimaryKeyField(fields);

  return {
    typeDefs,
    fields,
    primaryKeyField,
  };
}

function parseSchemaFields(typeDefs: string): SchemaField[] {
  const fields: SchemaField[] = [];
  
  // Simple regex-based parsing for SDL
  const typeMatch = typeDefs.match(/type\s+\w+\s*\{([^}]+)\}/);
  if (!typeMatch) {
    throw new ConfigError('Invalid schema: no type definition found', 'SCHEMA_FORMAT');
  }

  const fieldsText = typeMatch[1]!;
  const fieldLines = fieldsText.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));

  for (const line of fieldLines) {
    const fieldMatch = line.match(/(\w+):\s*([^!]+)(!?)(\s*#.*)?$/);
    if (!fieldMatch) continue;

    const [, name, type, required] = fieldMatch;
    const isPrimaryKey = type!.trim() === 'ID';
    
    fields.push({
      name: name!,
      type: type!.trim(),
      nullable: !required,
      isPrimaryKey,
    });
  }

  if (fields.length === 0) {
    throw new ConfigError('Invalid schema: no fields found', 'SCHEMA_FORMAT');
  }

  return fields;
}

function findPrimaryKeyField(fields: SchemaField[]): string {
  const primaryKeyFields = fields.filter(field => field.isPrimaryKey);
  
  if (primaryKeyFields.length === 0) {
    throw new ConfigError(
      `Schema must contain exactly one field of type ID! ` +
      `This field serves as the primary key for caching and updates. ` +
      `Example: "instrument_id: ID!" in your type definition.`,
      'SCHEMA_PRIMARY_KEY'
    );
  }
  
  if (primaryKeyFields.length > 1) {
    const fieldNames = primaryKeyFields.map(f => f.name).join(', ');
    throw new ConfigError(
      `Schema must contain exactly one field of type ID! (found multiple: ${fieldNames}). ` +
      `Please designate only one field as the primary key with type "ID!".`,
      'SCHEMA_PRIMARY_KEY'
    );
  }

  return primaryKeyFields[0]!.name;
}

function getExampleValue(envVar: string): string {
  const examples: Record<string, string> = {
    SOURCE_HOST: 'localhost',
    SOURCE_PORT: '6875',
    SOURCE_USER: 'materialize',
    SOURCE_PASSWORD: 'materialize',
    SOURCE_DB: 'materialize',
    VIEW_NAME: 'live_pnl',
  };
  return examples[envVar] || 'your-value-here';
}