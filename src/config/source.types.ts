// Types for source definitions loaded from YAML

import type { PostgresType } from '../common/types.js';

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
 */
export interface SourceField {
  name: string;
  type: PostgresType; // The column's Postgres type
  enumType?: EnumType; // Present when this field is an enum
}

/**
 * A column of a source that references another source's primary key, as a
 * foreign key does in Postgres
 */
export interface ForeignKey {
  column: string;
  references: SourceDefinition;
}

/**
 * Complete definition of a data source for streaming
 * Maps to a database view that we subscribe to and expose via GraphQL
 */
export interface SourceDefinition {
  name: string; // Source name (e.g., 'trades', 'positions')
  primaryKeyField: string; // Which field is the primary key
  fields: SourceField[]; // All fields in this source
  foreignKeys?: ForeignKey[]; // Its columns that reference other sources
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
 * Contains primary_key and columns mapping, and its foreign keys: each
 * column that references another source, by that source's name
 */
export interface YamlSourceConfig {
  primary_key: string;
  columns: Record<string, string>;
  foreign_keys?: Record<string, string>;
}

/**
 * Top-level structure of the sources YAML file (schema.yaml)
 * Each source key becomes a GraphQL subscription field
 */
export interface YamlSourcesFile {
  enums?: Record<string, string[]>; // Optional enum definitions
  sources: Record<string, YamlSourceConfig>;
}
