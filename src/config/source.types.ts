// Types for source definitions loaded from YAML

import { DataType } from '../common/types';

// Re-export for use by other modules
export { DataType } from '../common/types';

/**
 * Represents a single field/column in a data source
 * Uses our internal type system for clean separation
 */
export interface SourceField {
  name: string;
  dataType: DataType;       // Our internal type representation
}

/**
 * Helper to determine if a field is an enum
 * This will be updated when we add enumType support
 */
export function isEnumField(field: SourceField): boolean {
  // TODO: Will check field.enumType once we add enum support
  // For now, always return false since Enum was removed from DataType
  return false;
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