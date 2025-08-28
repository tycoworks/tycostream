import { Expression } from '../streaming/types';

/**
 * Trigger definition stored in the registry
 */
export class Trigger {
  name: string;
  source: string;
  webhook: string;
  match: Expression;
  unmatch: Expression;
  createdAt: Date = new Date();
  
  constructor(config: {
    name: string;
    source: string;
    webhook: string;
    match: Expression;
    unmatch?: Expression;
  }) {
    this.name = config.name;
    this.source = config.source;
    this.webhook = config.webhook;
    this.match = config.match;
    
    // If unmatch not provided, use negation of match
    this.unmatch = config.unmatch || {
      evaluate: (row: any) => !config.match.evaluate(row),
      fields: config.match.fields,
      expression: `!(${config.match.expression})`
    };
  }
}