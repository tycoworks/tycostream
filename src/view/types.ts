// Row events moved to common/types.ts; re-exported for the code that's deleted at the switch-over
export { RowUpdateType } from '../common/types.js';
export type { RowUpdateEvent } from '../common/types.js';

/**
 * Expression for evaluating row conditions
 * Created by GraphQL layer, executed by streaming layer
 */
export interface Expression {
  evaluate: (row: any) => boolean;
  fields: Set<string>; // Fields used in the expression for optimization
  expression: string; // The expression string for debugging/logging
}
