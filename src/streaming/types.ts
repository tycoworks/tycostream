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
 * fields: changed fields (UPDATE), all fields (INSERT), or key only (DELETE)
 * row: always contains all fields (needed for filter evaluation)
 */
export interface RowUpdateEvent {
  type: RowUpdateType;
  fields: Record<string, any>;  // Changed fields for UPDATE, all fields for INSERT, key only for DELETE
  row?: Record<string, any>;     // Full row data, optional and only used internally for filtering
}

/**
 * Filter for subscriptions
 * Created by GraphQL layer, executed by streaming layer
 */
export interface Filter {
  evaluate: (row: any) => boolean;
  fields: Set<string>;  // Fields used in the filter for optimization
  expression: string;   // The filter expression for debugging/logging
}