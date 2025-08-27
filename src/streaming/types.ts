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
 * Expression for evaluating row conditions
 * Created by GraphQL layer, executed by streaming layer
 */
export interface Expression {
  evaluate: (row: any) => boolean;
  fields: Set<string>;  // Fields used in the expression for optimization
  expression: string;   // The expression string for debugging/logging
}

/**
 * View filter configuration with match/unmatch conditions
 */
export interface ViewFilter {
  match: Expression;
  unmatch?: Expression;
}