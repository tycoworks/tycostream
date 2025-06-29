export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  viewName: string;
}

export interface StreamEvent {
  row: Record<string, any>;
  diff: number;
}

export interface SchemaField {
  name: string;
  type: string;
  nullable: boolean;
  isPrimaryKey: boolean;
}

export interface LoadedSchema {
  typeDefs: string;
  fields: SchemaField[];
  primaryKeyField: string;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component?: string;
  operation?: string;
  viewName?: string;
  clientId?: string;
  [key: string]: any;
}