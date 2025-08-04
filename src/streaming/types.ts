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
 * fields: set of field names that are relevant for this event
 *   - INSERT: all field names
 *   - UPDATE: changed field names (including primary key)
 *   - DELETE: primary key only
 * row: complete row data (always present)
 */
export interface RowUpdateEvent {
  type: RowUpdateType;
  fields: Set<string>;  // Field names relevant to this event
  row: Record<string, any>;  // Complete row data
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