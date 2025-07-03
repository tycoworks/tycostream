import { z } from 'zod';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import type { DatabaseConfig, LoadedSchema, SchemaField } from '../shared/types.js';

// Load .env file from project root
config();

// Define environment schema with validation
const envSchema = z.object({
  // Database config
  SOURCE_HOST: z.string().min(1, 'SOURCE_HOST is required'),
  SOURCE_PORT: z.string()
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535)),
  SOURCE_USER: z.string().min(1, 'SOURCE_USER is required'),
  SOURCE_PASSWORD: z.string().min(1, 'SOURCE_PASSWORD is required'),
  SOURCE_DB: z.string().min(1, 'SOURCE_DB is required'),
  
  // GraphQL config
  GRAPHQL_PORT: z.string()
    .optional()
    .default('4000')
    .transform((val) => parseInt(val, 10))
    .pipe(z.number().int().min(1).max(65535)),
  GRAPHQL_UI: z.enum(['true', 'false'])
    .optional()
    .default('false')
    .transform(val => val === 'true'),
  
  // Logging
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error'])
    .optional()
    .default('info')
});

// Infer the type from schema
type EnvConfig = z.infer<typeof envSchema>;

// Parse all env vars once (cache for performance, but allow reset for tests)
let parsedEnv: EnvConfig | null = null;

function getEnvConfig(): EnvConfig {
  // In test environment, don't cache to allow env var changes
  const shouldCache = process.env.NODE_ENV !== 'test';
  
  if (!parsedEnv || !shouldCache) {
    try {
      const parsed = envSchema.parse(process.env);
      if (shouldCache) {
        parsedEnv = parsed;
      }
      return parsed;
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Format Zod errors into helpful messages
        const issues = error.issues.map(issue => {
          const path = issue.path.join('.');
          const example = getExampleValue(path);
          return `${path}: ${issue.message}. Example: ${path}=${example}`;
        }).join('\n');
        
        throw new ConfigError(
          `Configuration validation failed:\n${issues}`,
          error.issues[0]?.path.join('.')
        );
      }
      throw error;
    }
  }
  return parsedEnv;
}

export class ConfigError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadDatabaseConfig(): DatabaseConfig {
  const env = getEnvConfig();
  
  return {
    host: env.SOURCE_HOST,
    port: env.SOURCE_PORT,
    user: env.SOURCE_USER,
    password: env.SOURCE_PASSWORD,
    database: env.SOURCE_DB,
  };
}

export function getGraphQLPort(): number {
  return getEnvConfig().GRAPHQL_PORT;
}

export function isGraphQLUIEnabled(): boolean {
  return getEnvConfig().GRAPHQL_UI;
}

export function getLogLevel(): string {
  return getEnvConfig().LOG_LEVEL;
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
  const viewName = extractViewName(typeDefs);

  return {
    typeDefs,
    fields,
    primaryKeyField,
    viewName,
  };
}

function extractViewName(typeDefs: string): string {
  // Find all type definitions and filter out Query and Subscription types
  const allTypeMatches = typeDefs.match(/type\s+(\w+)\s*\{[^}]+\}/g) || [];
  const dataTypeMatches = allTypeMatches.filter(match => 
    !match.includes('type Subscription') && !match.includes('type Query')
  );
  
  if (dataTypeMatches.length === 0) {
    throw new ConfigError('Invalid schema: no data type definition found', 'SCHEMA_FORMAT');
  }
  
  // Extract the type name from the first data type
  const typeNameMatch = dataTypeMatches[0]!.match(/type\s+(\w+)\s*\{/);
  if (!typeNameMatch) {
    throw new ConfigError('Invalid schema: malformed type definition', 'SCHEMA_FORMAT');
  }
  
  return typeNameMatch[1]!;
}

function parseSchemaFields(typeDefs: string): SchemaField[] {
  const fields: SchemaField[] = [];
  
  // Check for multiple type definitions - we only support one data type (excluding Query and Subscription)
  const allTypeMatches = typeDefs.match(/type\s+\w+\s*\{[^}]+\}/g) || [];
  const dataTypeMatches = allTypeMatches.filter(match => 
    !match.includes('type Subscription') && !match.includes('type Query')
  );
  
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
    GRAPHQL_PORT: '4000',
    GRAPHQL_UI: 'true',
    LOG_LEVEL: 'info',
  };
  return examples[envVar] || 'your-value-here';
}