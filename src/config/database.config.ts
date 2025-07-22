import { registerAs } from '@nestjs/config';
import { IsInt, IsNotEmpty, IsString, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';

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

export default registerAs('database', (): DatabaseConfig => ({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '6875', 10),
  user: process.env.DATABASE_USER || 'materialize',
  password: process.env.DATABASE_PASSWORD || 'materialize',
  database: process.env.DATABASE_NAME || 'materialize',
}));