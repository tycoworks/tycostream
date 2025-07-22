export enum RowUpdateType {
  Insert,
  Update,
  Delete
}

export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}

export interface ProtocolHandler {
  /**
   * Create the streaming query for this database protocol
   */
  createSubscribeQuery(): string;

  /**
   * Parse a line from the COPY stream
   * Returns null if the line should be skipped
   */
  parseLine(line: string): { row: Record<string, any>; timestamp: bigint; isDelete: boolean } | null;
}