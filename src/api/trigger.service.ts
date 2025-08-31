import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { ExpressionTree, buildExpression } from '../common/expressions';
import { ViewService } from '../view/view.service';
import { Filter } from '../view/filter';
import { RowUpdateEvent, RowUpdateType } from '../view/types';

/**
 * Trigger event types for webhook payloads
 */
export enum TriggerEventType {
  Match = 'MATCH',
  Unmatch = 'UNMATCH'
}

export interface Trigger {
  name: string;
  webhook: string;
  match: ExpressionTree;
  unmatch?: ExpressionTree;
}

interface ActiveTrigger extends Trigger {
  subscription: Subscription;
}

export class TriggerService implements OnModuleDestroy {
  private readonly logger = new Logger(TriggerService.name);
  // Source -> Name -> ActiveTrigger (names scoped by source)
  private readonly triggers = new Map<string, Map<string, ActiveTrigger>>();

  constructor(private readonly viewService: ViewService) {}

  async createTrigger(
    source: string,
    input: {
      name: string;
      webhook: string;
      match: ExpressionTree;
      unmatch?: ExpressionTree;
    }
  ): Promise<Trigger> {
    // Get or create source map
    let sourceTriggers = this.triggers.get(source);
    if (!sourceTriggers) {
      sourceTriggers = new Map<string, ActiveTrigger>();
      this.triggers.set(source, sourceTriggers);
    }

    // Check for duplicate name within source
    if (sourceTriggers.has(input.name)) {
      throw new Error(`Trigger ${input.name} already exists for source ${source}`);
    }

    const trigger: Trigger = {
      ...input,
    };

    // Create View subscription with asymmetric filtering
    const matchExpression = buildExpression(input.match);
    const unmatchExpression = input.unmatch 
      ? buildExpression(input.unmatch)
      : undefined;
    const filter = new Filter(matchExpression, unmatchExpression);

    // Subscribe to View updates (skipSnapshot=true to avoid firing on existing data)
    const subscription = this.viewService
      .getUpdates(source, filter, false, true)
      .subscribe({
        next: (event: RowUpdateEvent) => this.processEvent(source, trigger.name, event),
        error: (error) => {
          this.logger.error(`Error in trigger ${trigger.name}: ${error.message}`);
        },
      });

    // Store trigger with subscription
    const activeTrigger: ActiveTrigger = {
      ...trigger,
      subscription,
    };

    sourceTriggers.set(trigger.name, activeTrigger);
    this.logger.log(`Created trigger: ${trigger.name} for source: ${source}`);

    return trigger;
  }

  async deleteTrigger(source: string, name: string): Promise<Trigger> {
    const sourceTriggers = this.triggers.get(source);
    const activeTrigger = sourceTriggers?.get(name);
    
    if (!activeTrigger) {
      throw new Error(`Trigger ${name} not found for source ${source}`);
    }

    // Clean up View subscription
    activeTrigger.subscription.unsubscribe();

    sourceTriggers!.delete(name);
    
    // Clean up source map if empty
    if (sourceTriggers!.size === 0) {
      this.triggers.delete(source);
    }
    
    this.logger.log(`Deleted trigger: ${name} from source: ${source}`);

    return activeTrigger;
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
   * Process trigger events from View
   */
  private processEvent(
    source: string,
    triggerName: string,
    event: RowUpdateEvent
  ): void {
    // Process different event types
    if (event.type === RowUpdateType.Insert) {
      // Row matched the trigger condition
      this.logger.log(
        `Trigger ${triggerName} fired: ${TriggerEventType.Match} for source ${source}, ` +
        `row: ${JSON.stringify(event.row)}`
      );
      // TODO: Send webhook with MATCH event
      
    } else if (event.type === RowUpdateType.Delete) {
      // Row unmatched the trigger condition
      this.logger.log(
        `Trigger ${triggerName} fired: ${TriggerEventType.Unmatch} for source ${source}, ` +
        `row: ${JSON.stringify(event.row)}`
      );
      // TODO: Send webhook with UNMATCH event
      
    } else {
      // Skip UPDATE events (triggers only care about match/unmatch transitions)
      return;
    }
  }

  /**
   * Clean up all active trigger subscriptions
   * Implements OnModuleDestroy for proper lifecycle management
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log('Disposing all triggers...');
    
    // Clean up all View subscriptions
    for (const [source, sourceTriggers] of this.triggers) {
      for (const [name, activeTrigger] of sourceTriggers) {
        this.logger.debug(`Unsubscribing trigger ${name} from source ${source}`);
        activeTrigger.subscription.unsubscribe();
      }
      sourceTriggers.clear();
    }
    this.triggers.clear();
    
    this.logger.log('All triggers disposed');
  }
}