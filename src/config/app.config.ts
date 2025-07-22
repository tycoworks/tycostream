import { registerAs } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';

export class AppConfig {
  @IsString()
  @IsOptional()
  schemaPath: string;
}

export default registerAs('app', (): AppConfig => ({
  // Schema path can be provided via env var or CLI argument
  schemaPath: process.env.SCHEMA_PATH || './config/schema.yaml',
}));