import { Expression } from './types';

/**
 * Filter configuration with match/unmatch conditions
 * Automatically normalizes unmatch to negation of match if not provided
 */
export class Filter {
  readonly match: Expression;
  readonly unmatch: Expression;
  readonly fields: Set<string>;
  
  constructor(match: Expression, unmatch?: Expression) {
    this.match = match;
    this.unmatch = unmatch || {
      evaluate: (row) => !match.evaluate(row),
      fields: match.fields,
      expression: `!(${match.expression})`
    };
    this.fields = new Set([...this.match.fields, ...this.unmatch.fields]);
  }
}