import { z } from 'zod';
import { existsSync } from 'fs';
import { join } from 'path';
import { config } from 'dotenv';
import type { LogLevel } from '../shared/logger.js';
import { loadSchemaFromYaml, type LoadedSchema } from '../shared/schema.js';

// Database configuration
export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

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

export function getLogLevel(): LogLevel {
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
  
  try {
    return loadSchemaFromYaml(configDir);
  } catch (error) {
    if (error instanceof Error) {
      throw new ConfigError(
        `Failed to load schema: ${error.message}`,
        'SCHEMA_FILE'
      );
    }
    throw error;
  }
}

// Note: GraphQL schema is now generated from YAML configuration.
// Schema loading handled by loadSchemaFromYaml() from shared/schema.ts

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