// Types for source definitions loaded from YAML

/**
 * Represents a single field/column in a data source
 * Type must be a valid PostgreSQL type for GraphQL mapping and parsing
 */
export interface SourceField {
  name: string;
  type: string;  // PostgreSQL type from YAML
}

/**
 * Complete definition of a data source for streaming
 * Maps to a database view that we subscribe to and expose via GraphQL
 */
export interface SourceDefinition {
  name: string;              // Source name (e.g., 'trades', 'live_pnl')
  primaryKeyField: string;   // Which field is the primary key
  fields: SourceField[];     // All fields in this source
}

/**
 * Structure of a single source in the YAML file
 * Contains primary_key and columns mapping
 */
export interface YamlSourceConfig {
  primary_key: string;
  columns: Record<string, string>;
}

/**
 * Top-level structure of the sources YAML file (schema.yaml)
 * Each source key becomes a GraphQL subscription field
 */
export interface YamlSourcesFile {
  sources: Record<string, YamlSourceConfig>;
}