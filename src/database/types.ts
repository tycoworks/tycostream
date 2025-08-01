/**
 * Row update event types sent to GraphQL clients
 * Maps to GraphQL's RowOperation enum (INSERT/UPDATE/DELETE)
 */
export enum RowUpdateType {
  Insert,
  Update,
  Delete
}

/**
 * Database row update types from protocol handlers
 * More specific than RowUpdateType - represents what the database tells us
 */
export enum DatabaseRowUpdateType {
  Delete = 'DELETE',
  Upsert = 'UPSERT',  // Could be INSERT or UPDATE, we need to check cache
  // Future: Diff = 'DIFF', Insert = 'INSERT', etc.
}

/**
 * Row update event sent to GraphQL subscriptions
 * Row contains: all fields (INSERT), changed fields (UPDATE), or key only (DELETE)
 */
export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}

/**
 * Interface for database-specific protocol implementations
 * Abstracts query construction and wire format parsing
 */
export interface ProtocolHandler {
  /**
   * Create the streaming query for this database protocol
   */
  createSubscribeQuery(): string;

  /**
   * Parse a line from the COPY stream
   * Returns null if the line should be skipped
   */
  parseLine(line: string): { 
    row: Record<string, any>; 
    timestamp: bigint; 
    updateType: DatabaseRowUpdateType;
  } | null;
}