import { registerAs } from '@nestjs/config';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { validateConfig } from './config-validation';

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
  };
  
  return validateConfig(rawConfig, 'database', DatabaseConfig);
});