import type { SourceSchema } from '../core/schema.js';
import type { ProtocolHandler } from './types.js';
import { logger } from '../core/logger.js';

/**
 * Handles Materialize-specific protocol details: query generation and data parsing
 */
export class MaterializeProtocolHandler implements ProtocolHandler {
  private log = logger.child({ component: 'materialize-protocol' });
  private columnNames: string[];

  constructor(private schema: SourceSchema) {
    // Initialize column names for COPY stream parsing
    // With ENVELOPE UPSERT, output format is: [mz_timestamp, mz_state, key_columns..., value_columns...]
    const keyFields = schema.fields.filter(f => f.name === schema.primaryKeyField);
    const nonKeyFields = schema.fields.filter(f => f.name !== schema.primaryKeyField);
    this.columnNames = ['mz_timestamp', 'mz_state', ...keyFields.map(f => f.name), ...nonKeyFields.map(f => f.name)];
    
    this.log.debug('MaterializeProtocolHandler initialized', { 
      columnCount: this.columnNames.length,
      columns: this.columnNames,
      primaryKeyField: schema.primaryKeyField
    });
  }

  /**
   * Create the SUBSCRIBE query for Materialize (without COPY wrapper)
   */
  createSubscribeQuery(): string {
    const keyColumn = this.schema.primaryKeyField;
    const query = `SUBSCRIBE TO ${this.schema.sourceName} ENVELOPE UPSERT (KEY (${keyColumn})) WITH (SNAPSHOT)`;
    this.log.debug('Created subscribe query', { query });
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