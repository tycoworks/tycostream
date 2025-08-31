import { Injectable, Logger } from '@nestjs/common';
import { WhereClause } from '../common/expressions';

export interface TriggerConfig {
  name: string;
  source: string;
  webhook: string;
  match: WhereClause;
  unmatch?: WhereClause;
}

@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);
  private readonly triggers = new Map<string, TriggerConfig>();

  async createTrigger(input: {
    name: string;
    source: string;
    webhook: string;
    match: WhereClause;
    unmatch?: WhereClause;
  }): Promise<TriggerConfig> {
    const trigger: TriggerConfig = {
      ...input,
    };

    this.triggers.set(trigger.name, trigger);
    this.logger.log(`Created trigger: ${trigger.name}`);

    // TODO: Create View subscription for this trigger

    return trigger;
  }

  async deleteTrigger(name: string): Promise<TriggerConfig> {
    const trigger = await this.getTrigger(name); // Will throw if not found

    this.triggers.delete(name);
    this.logger.log(`Deleted trigger: ${name}`);

    // TODO: Clean up View subscription

    return trigger;
  }

  async getTrigger(name: string): Promise<TriggerConfig> {
    const trigger = this.triggers.get(name);
    if (!trigger) {
      throw new Error(`Trigger ${name} not found`);
    }
    return trigger;
  }

  async listTriggers(): Promise<TriggerConfig[]> {
    return Array.from(this.triggers.values());
  }
}