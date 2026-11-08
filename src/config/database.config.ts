import { registerAs } from '@nestjs/config';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { validateConfig } from './validation.js';

/**
 * Database connection configuration
 * Validated using class-validator decorators
 */
export class DatabaseConfig {
  @IsString()
  @IsNotEmpty()
  host: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  port: number;

  @IsString()
  @IsNotEmpty()
  user: string;

  @IsString()
  @IsNotEmpty()
  password: string;

  @IsString()
  @IsNotEmpty()
  database: string;

  // Most connections at once: each subscription holds one, each query
  // borrows one
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxConnections: number;

  // Time limit on a query, waiting for a connection included. Enforced on
  // tycostream's side: Materialize's statement_timeout doesn't apply to SELECT
  @Type(() => Number)
  @IsInt()
  @Min(1)
  queryTimeoutMs: number;
}

/**
 * Database configuration factory
 * Loads database settings from environment variables with defaults
 */
export default registerAs('database', (): DatabaseConfig => {
  const rawConfig = {
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '6875', 10),
    user: process.env.DATABASE_USER || 'materialize',
    password: process.env.DATABASE_PASSWORD || 'materialize',
    database: process.env.DATABASE_NAME || 'materialize',
    maxConnections: parseInt(
      process.env.DATABASE_MAX_CONNECTIONS || '1000',
      10,
    ),
    queryTimeoutMs: parseInt(
      process.env.DATABASE_QUERY_TIMEOUT_MS || '30000',
      10,
    ),
  };

  return validateConfig(rawConfig, 'database', DatabaseConfig);
});
