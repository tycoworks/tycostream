import { Logger } from '@nestjs/common';
import type { SourceDefinition } from '../config/source-definition.types';
import type { ProtocolHandler } from './types';

/**
 * Handles Materialize-specific protocol details: query generation and data parsing
 */
export class MaterializeProtocolHandler implements ProtocolHandler {
  private readonly logger = new Logger(MaterializeProtocolHandler.name);
  private columnNames: string[];

  constructor(
    private sourceDefinition: SourceDefinition,
    private sourceName: string
  ) {
    // Initialize column names for COPY stream parsing
    // With ENVELOPE UPSERT, output format is: [mz_timestamp, mz_state, key_columns..., value_columns...]
    const keyFields = sourceDefinition.fields.filter(f => f.name === sourceDefinition.primaryKeyField);
    const nonKeyFields = sourceDefinition.fields.filter(f => f.name !== sourceDefinition.primaryKeyField);
    this.columnNames = ['mz_timestamp', 'mz_state', ...keyFields.map(f => f.name), ...nonKeyFields.map(f => f.name)];
    
    this.logger.debug(`MaterializeProtocolHandler initialized for ${sourceName}`, { 
      columnCount: this.columnNames.length,
      columns: this.columnNames,
      primaryKeyField: sourceDefinition.primaryKeyField
    });
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
    if (fields.length < 2) return null;

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
        row[columnName] = field === '\\N' ? null : field;
      }
    }

    const isDelete = mzState === 'delete';
    return { row, timestamp, isDelete };
  }
}