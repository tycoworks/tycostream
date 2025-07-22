// Types for source definitions loaded from YAML

export interface SourceField {
  name: string;
  type: string;  // PostgreSQL type from YAML
}

export interface SourceDefinition {
  name: string;              // Source name (e.g., 'trades', 'live_pnl')
  primaryKeyField: string;   // Which field is the primary key
  fields: SourceField[];     // All fields in this source
}

// YAML file structure
export interface YamlSourceConfig {
  primary_key: string;
  columns: Record<string, string>;
}

export interface YamlSourcesFile {
  sources: Record<string, YamlSourceConfig>;
}