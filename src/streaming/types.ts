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
 * Row update event sent to GraphQL subscriptions
 * Row contains: all fields (INSERT), changed fields (UPDATE), or key only (DELETE)
 */
export interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>;
}