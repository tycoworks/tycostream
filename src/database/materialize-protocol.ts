import { Logger } from '@nestjs/common';
import type { SourceDefinition } from '../config/source-definition.types';
import type { ProtocolHandler } from './types';
import { getPostgresType } from '../common/type-map';
import * as pgTypes from 'pg-types';

/**
 * Handles Materialize-specific protocol details: query generation and data parsing
 */
export class MaterializeProtocolHandler implements ProtocolHandler {
  private readonly logger = new Logger(MaterializeProtocolHandler.name);
  private columnNames: string[];
  private columnTypes: Map<string, string>;

  constructor(
    private sourceDefinition: SourceDefinition,
    private sourceName: string
  ) {
    // Initialize column names for COPY stream parsing
    // With ENVELOPE UPSERT, Materialize reorders output: [mz_timestamp, mz_state, key_columns, value_columns]
    const keyFields = sourceDefinition.fields.filter(f => f.name === sourceDefinition.primaryKeyField);
    const nonKeyFields = sourceDefinition.fields.filter(f => f.name !== sourceDefinition.primaryKeyField);
    this.columnNames = ['mz_timestamp', 'mz_state', ...keyFields.map(f => f.name), ...nonKeyFields.map(f => f.name)];
    
    // Build column type map
    this.columnTypes = new Map();
    sourceDefinition.fields.forEach(field => {
      this.columnTypes.set(field.name, field.type);
    });
    
    this.logger.debug(`MaterializeProtocolHandler initialized for ${sourceName} - columns: ${this.columnNames.length} [${this.columnNames.join(', ')}], primaryKey: ${sourceDefinition.primaryKeyField}`);
  }

  /**
   * Create the SUBSCRIBE query for Materialize (without COPY wrapper)
   */
  createSubscribeQuery(): string {
    const keyColumn = this.sourceDefinition.primaryKeyField;
    const query = `SUBSCRIBE TO ${this.sourceName} ENVELOPE UPSERT (KEY (${keyColumn})) WITH (SNAPSHOT)`;
    this.logger.debug(`Created subscribe query: ${query}`);
    return query;
  }

  /**
   * Parse a single line of COPY output
   * Returns null if the line should be skipped
   */
  parseLine(line: string): { row: Record<string, any>; timestamp: bigint; isDelete: boolean } | null {
    const trimmed = line.trim();
    if (!trimmed) return null;

    const fields = trimmed.split('\t');
    // Materialize COPY protocol requires at least timestamp and diff fields
    const MATERIALIZE_MINIMUM_FIELDS = 2;
    if (fields.length < MATERIALIZE_MINIMUM_FIELDS) return null;

    // Parse timestamp (first field)
    const timestampField = fields[0];
    if (!timestampField) return null;
    
    let timestamp: bigint;
    try {
      timestamp = BigInt(timestampField);
    } catch {
      return null; // Invalid timestamp
    }

    // Parse mz_state (second field) - either 'upsert' or 'delete'
    const mzState = fields[1];
    if (!mzState) return null;

    // Map remaining fields to row data (skip mz_timestamp and mz_state)
    const row: Record<string, any> = {};
    for (let i = 2; i < fields.length && i < this.columnNames.length; i++) {
      const columnName = this.columnNames[i];
      const field = fields[i];
      if (columnName && field !== undefined) {
        const typeName = this.columnTypes.get(columnName);
        row[columnName] = typeName 
          ? this.parseValue(field, typeName)
          : field;
      }
    }

    const isDelete = mzState === 'delete';
    return { row, timestamp, isDelete };
  }

  /**
   * Parse a COPY text format value based on PostgreSQL type
   */
  private parseValue(value: string, typeName: string): any {
    // Handle COPY format NULL
    if (value === '\\N') return null;
    
    // Get PostgreSQL type OID
    const pgType = getPostgresType(typeName);
    
    // Parse based on PostgreSQL type
    switch (pgType) {
      case pgTypes.builtins.BOOL:
        return value === 't' || value === 'true';
      
      case pgTypes.builtins.INT2:
      case pgTypes.builtins.INT4:
        return parseInt(value, 10);
      
      case pgTypes.builtins.INT8:
        // Keep as string to preserve precision
        return value;
      
      case pgTypes.builtins.FLOAT4:
      case pgTypes.builtins.FLOAT8:
      case pgTypes.builtins.NUMERIC:
        return parseFloat(value);
      
      // All string-based types
      case pgTypes.builtins.TEXT:
      case pgTypes.builtins.VARCHAR:
      case pgTypes.builtins.UUID:
      case pgTypes.builtins.TIMESTAMP:
      case pgTypes.builtins.TIMESTAMPTZ:
      case pgTypes.builtins.DATE:
      case pgTypes.builtins.TIME:
      case pgTypes.builtins.JSON:
      case pgTypes.builtins.JSONB:
        return value;
      
      default:
        return value; // Unknown type, keep as string
    }
  }
}