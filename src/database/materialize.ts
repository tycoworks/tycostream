import { Logger } from '@nestjs/common';
import type { SourceDefinition } from '../config/source.types';
import { DataType } from '../common/types';
import type { ProtocolHandler } from './types';
import { DatabaseRowUpdateType } from './types';

/**
 * Handles Materialize-specific protocol details: query generation and data parsing
 * Implements the ProtocolHandler interface for Materialize's SUBSCRIBE with ENVELOPE UPSERT
 */
export class MaterializeProtocolHandler implements ProtocolHandler {
  private readonly logger = new Logger(MaterializeProtocolHandler.name);
  private columnNames: string[];
  private columnTypes: Map<string, DataType>;

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
      this.columnTypes.set(field.name, field.dataType);
    });
    
    this.logger.debug(`MaterializeProtocolHandler initialized for ${sourceName} - columns: ${this.columnNames.length} [${this.columnNames.join(', ')}], primaryKey: ${sourceDefinition.primaryKeyField}`);
  }

  /**
   * Create the SUBSCRIBE query for Materialize (without COPY wrapper)
   * Uses ENVELOPE UPSERT format with KEY field and SNAPSHOT for late joiners
   */
  createSubscribeQuery(): string {
    const keyColumn = this.sourceDefinition.primaryKeyField;
    // Get all column names from the source definition
    const columns = this.sourceDefinition.fields.map(f => f.name).join(', ');
    
    // Use SELECT to explicitly specify columns from our YAML definition
    const query = `SUBSCRIBE (SELECT ${columns} FROM ${this.sourceName}) ENVELOPE UPSERT (KEY (${keyColumn})) WITH (SNAPSHOT)`;
    this.logger.debug(`Created subscribe query: ${query}`);
    return query;
  }

  /**
   * Parse a single line of COPY output
   * Returns null if the line should be skipped
   */
  parseLine(line: string): { row: Record<string, any>; timestamp: bigint; updateType: DatabaseRowUpdateType } | null {
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
        const dataType = this.columnTypes.get(columnName);
        row[columnName] = dataType !== undefined
          ? parseValueFromDataType(field, dataType)
          : field;
      }
    }

    const updateType = mzState === 'delete' 
      ? DatabaseRowUpdateType.Delete 
      : DatabaseRowUpdateType.Upsert;
      
    return { row, timestamp, updateType };
  }
}

/**
 * Parse a COPY text format value based on DataType
 * Handles PostgreSQL COPY format including \\N for NULL
 */
function parseValueFromDataType(value: string, dataType: DataType): any {
  // Handle COPY format NULL
  if (value === '\\N') return null;

  switch (dataType) {
    case DataType.Boolean:
      return value === 't' || value === 'true';

    case DataType.Integer:
      return parseInt(value, 10);

    case DataType.Float:
      return parseFloat(value);

    case DataType.BigInt:
      // Keep as string to preserve precision
      return value;

    // All string-based types
    case DataType.String:
    case DataType.UUID:
    case DataType.Timestamp:
    case DataType.Date:
    case DataType.Time:
    case DataType.JSON:
    case DataType.Array:
      return value;

    default:
      return value;
  }
}