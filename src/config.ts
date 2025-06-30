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

function findConfigRoot(): string {
  // In Docker, we're in /app, config is in /app/config
  // In local dev, we're in project root, config is in ./config
  
  const configPath = join(process.cwd(), 'config');
  
  // Check if config directory exists
  try {
    if (existsSync(configPath)) {
      return configPath;
    }
  } catch {
    // Continue with default
  }
  
  // Default to config directory
  return configPath;
}

export function loadSchema(): LoadedSchema {
  const configDir = findConfigRoot();
  const schemaPath = join(configDir, 'schema.sdl');
  
  let typeDefs: string;
  try {
    typeDefs = readFileSync(schemaPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError(
        `Schema file not found: ${schemaPath}. ` +
        `Please copy config/schema.example.sdl to config/schema.sdl and customize it. ` +
        `The schema must define exactly one type and a Subscription.`,
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
  
  // Check for multiple type definitions - we only support one data type (excluding Subscription)
  const allTypeMatches = typeDefs.match(/type\s+\w+\s*\{[^}]+\}/g) || [];
  const dataTypeMatches = allTypeMatches.filter(match => !match.includes('type Subscription'));
  
  if (dataTypeMatches.length === 0) {
    throw new ConfigError('Invalid schema: no data type definition found', 'SCHEMA_FORMAT');
  }
  
  if (dataTypeMatches.length > 1) {
    throw new ConfigError(
      `Schema must contain exactly one data type definition (found ${dataTypeMatches.length}). ` +
      `Multiple data types will be supported in future versions.`,
      'SCHEMA_FORMAT'
    );
  }
  
  // Parse the single data type definition
  const typeMatch = dataTypeMatches[0]!.match(/type\s+\w+\s*\{([^}]+)\}/);
  if (!typeMatch) {
    throw new ConfigError('Invalid schema: malformed type definition', 'SCHEMA_FORMAT');
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