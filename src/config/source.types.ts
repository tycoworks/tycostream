// Types for source definitions loaded from YAML

import { DataType } from '../common/types';

// Re-export for use by other modules
export { DataType } from '../common/types';

/**
 * Defines an enum type with its allowed values
 * Values array determines ordering for comparison operators
 */
export interface EnumType {
  name: string;
  values: string[];
}

/**
 * Represents a single field/column in a data source
 * Uses our internal type system for clean separation
 */
export interface SourceField {
  name: string;
  dataType: DataType;       // Our internal type representation
  enumType?: EnumType;      // Present when this field is an enum
}

/**
 * Helper to determine if a field is an enum
 */
export function isEnumField(field: SourceField): boolean {
  return field.enumType !== undefined;
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
 * Complete configuration containing both sources and enum definitions
 * This is what gets loaded from the YAML and passed around the system
 */
export interface SourceConfiguration {
  sources: Map<string, SourceDefinition>;
  enums: Map<string, EnumType>;
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
  enums?: Record<string, string[]>;  // Optional enum definitions
  sources: Record<string, YamlSourceConfig>;
}