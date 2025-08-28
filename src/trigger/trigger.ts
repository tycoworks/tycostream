import { Expression } from '../streaming/types';

/**
 * Match/unmatch configuration for a trigger
 */
export interface TriggerCondition {
  condition: Expression;
  webhook: string; // URL for webhook delivery
}

/**
 * Trigger definition stored in the registry
 */
export class Trigger {
  name: string;
  source: string;
  match: TriggerCondition;
  unmatch?: TriggerCondition;
  createdAt: Date = new Date();
  
  constructor(config: {
    name: string;
    source: string;
    match: TriggerCondition;
    unmatch?: TriggerCondition;
  }) {
    this.name = config.name;
    this.source = config.source;
    this.match = config.match;
    this.unmatch = config.unmatch;
  }
}