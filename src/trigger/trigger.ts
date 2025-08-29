import { Logger } from '@nestjs/common';
import { Subscription } from 'rxjs';
import { RowUpdateEvent, Expression } from '../streaming/types';
import type { Source } from '../streaming/source';
import { TriggerEventType } from './types';
import { StateTracker, StateTransition } from '../common/states';

/**
 * Trigger monitors a data stream for condition state changes
 * It tracks which rows match and fires webhooks on transitions
 * Similar to View but fires webhooks instead of emitting events
 */
export class Trigger {
  private readonly logger = new Logger(Trigger.name);
  private readonly stateTracker: StateTracker;
  private readonly subscription: Subscription;
  private readonly primaryKeyField: string;
  
  // Public fields for trigger identity
  name: string;
  webhook: string;
  match: Expression;
  unmatch?: Expression;  // Optional - StateTracker handles negation
  createdAt: Date = new Date();
  
  constructor(
    private readonly source: Source,
    name: string,
    webhook: string,
    match: Expression,
    unmatch?: Expression
  ) {
    this.primaryKeyField = source.getPrimaryKeyField();
    this.name = name;
    this.webhook = webhook;
    this.match = match;
    this.unmatch = unmatch;  // Can be undefined, StateTracker handles it
    
    // Create state tracker (handles unmatch negation internally)
    this.stateTracker = new StateTracker(this.primaryKeyField, this.match, this.unmatch);
    
    // Subscribe directly to live updates (no snapshot for triggers)
    this.subscription = source.getUpdates(true).subscribe({
      next: event => this.processEvent(event),
      error: error => this.logger.error(`Trigger stream error for '${this.name}': ${error.message}`, error.stack)
    });
  }
  
  /**
   * Process event using StateTracker and fire webhooks on transitions
   */
  private processEvent(event: RowUpdateEvent): void {
    const transition = this.stateTracker.processEvent(event);
    
    // Fire webhook only on state changes
    if (transition === StateTransition.Match) {
      this.fireWebhook(TriggerEventType.Match, event.row);
    } else if (transition === StateTransition.Unmatch) {
      this.fireWebhook(TriggerEventType.Unmatch, event.row);
    }
    // No action needed for other states
  }
  
  /**
   * Fire webhook for a trigger event
   */
  private fireWebhook(eventType: TriggerEventType, row: Record<string, any>): void {
    // TODO: Actually send HTTP request
    this.logger.log(`[TODO] Fire ${eventType} webhook for trigger '${this.name}' to ${this.webhook}`);
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.subscription.unsubscribe();
    this.stateTracker.dispose();
  }
}