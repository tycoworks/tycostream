export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
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
  viewName: string; // GraphQL type name
  databaseViewName: string; // Database view name
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component?: string;
  operation?: string;
  viewName?: string;
  clientId?: string;
  [key: string]: any;
}

export type DiffType = 'insert' | 'update' | 'delete';

export interface RowUpdateEvent {
  type: DiffType;
  row: Record<string, any>;
  previousRow?: Record<string, any>;
}

export interface CacheSubscriber {
  onUpdate(event: RowUpdateEvent): void;
}

export interface YamlViewConfig {
  view: string;
  columns: Record<string, string>;
}

export interface YamlSchemaConfig {
  views: Record<string, YamlViewConfig>;
}