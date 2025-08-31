import { Logger } from '@nestjs/common';
import { WhereClause } from '../common/expressions';

export interface Trigger {
  name: string;
  webhook: string;
  match: WhereClause;
  unmatch?: WhereClause;
}

export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);
  // Source -> Name -> Trigger (names scoped by source)
  private readonly triggers = new Map<string, Map<string, Trigger>>();

  constructor() {}

  async createTrigger(
    source: string,
    input: {
      name: string;
      webhook: string;
      match: WhereClause;
      unmatch?: WhereClause;
    }
  ): Promise<Trigger> {
    // Get or create source map
    let sourceTriggers = this.triggers.get(source);
    if (!sourceTriggers) {
      sourceTriggers = new Map<string, Trigger>();
      this.triggers.set(source, sourceTriggers);
    }

    // Check for duplicate name within source
    if (sourceTriggers.has(input.name)) {
      throw new Error(`Trigger ${input.name} already exists for source ${source}`);
    }

    const trigger: Trigger = {
      ...input,
    };

    sourceTriggers.set(trigger.name, trigger);
    this.logger.log(`Created trigger: ${trigger.name} for source: ${source}`);

    // TODO: Create View subscription for this trigger

    return trigger;
  }

  async deleteTrigger(source: string, name: string): Promise<Trigger> {
    const trigger = await this.getTrigger(source, name); // Will throw if not found

    // TODO: Clean up View subscription

    const sourceTriggers = this.triggers.get(source);
    sourceTriggers?.delete(name);
    
    // Clean up source map if empty
    if (sourceTriggers?.size === 0) {
      this.triggers.delete(source);
    }
    
    this.logger.log(`Deleted trigger: ${name} from source: ${source}`);

    return trigger;
  }

  async getTrigger(source: string, name: string): Promise<Trigger> {
    const sourceTriggers = this.triggers.get(source);
    const trigger = sourceTriggers?.get(name);
    
    if (!trigger) {
      throw new Error(`Trigger ${name} not found for source ${source}`);
    }
    return trigger;
  }

  async listTriggers(source: string): Promise<Trigger[]> {
    const sourceTriggers = this.triggers.get(source);
    if (!sourceTriggers) {
      return [];
    }
    return Array.from(sourceTriggers.values());
  }

  /**
   * Clean up all active trigger subscriptions
   * Should be called on module destroy
   */
  async dispose(): Promise<void> {
    this.logger.log('Disposing all triggers...');
    
    // TODO: Clean up all View subscriptions
    
    // Clear all nested maps
    for (const [source, sourceTriggers] of this.triggers) {
      sourceTriggers.clear();
    }
    this.triggers.clear();
    
    this.logger.log('All triggers disposed');
  }
}