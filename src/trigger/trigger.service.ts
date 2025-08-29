import { Injectable, Logger, NotFoundException, ConflictException, OnModuleDestroy } from '@nestjs/common';
import { buildExpression } from '../common/expressions';
import { SourceService } from '../streaming/source.service';
import { Trigger } from './trigger';
import { CreateTriggerDto } from './trigger.dto';

/**
 * TriggerService manages trigger instances
 * Similar to ViewService but triggers are persistent (not per-subscriber)
 * Each trigger monitors a source and fires webhooks on state changes
 */
@Injectable()
export class TriggerService implements OnModuleDestroy {
  private readonly logger = new Logger(TriggerService.name);
  private readonly triggers = new Map<string, Trigger>();

  constructor(
    private sourceService: SourceService
  ) {}

  /**
   * Create a new trigger
   */
  async create(dto: CreateTriggerDto): Promise<Trigger> {
    // Check for duplicate
    if (this.triggers.has(dto.name)) {
      throw new ConflictException(`Trigger with name '${dto.name}' already exists`);
    }

    // Get the source for this trigger
    const source = this.sourceService.getSource(dto.source);

    // Compile conditions to Expressions
    const match = buildExpression(dto.match);
    const unmatch = dto.unmatch ? buildExpression(dto.unmatch) : undefined;

    // Create trigger with Source (like View)
    const trigger = new Trigger(
      source,
      dto.name,
      dto.webhook,
      match,
      unmatch
    );

    // Store trigger (it self-subscribes in constructor)
    this.triggers.set(trigger.name, trigger);
    
    this.logger.log(`Created trigger '${trigger.name}' for source '${dto.source}'`);

    return trigger;
  }

  /**
   * Get all triggers
   */
  getAll(): Trigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get a specific trigger by name
   */
  get(name: string): Trigger {
    const trigger = this.triggers.get(name);
    if (!trigger) {
      throw new NotFoundException(`Trigger '${name}' not found`);
    }
    return trigger;
  }

  /**
   * Delete a trigger
   */
  async delete(name: string): Promise<void> {
    const trigger = this.get(name);
    
    // Dispose trigger resources (handles its own subscription)
    trigger.dispose();
    
    // Remove from registry
    this.triggers.delete(name);
    this.logger.log(`Deleted trigger '${name}'`);
  }

  /**
   * Clean up all triggers on module destroy
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down TriggerService...');
    
    // Dispose all triggers (each handles its own subscription)
    for (const [name, trigger] of this.triggers.entries()) {
      trigger.dispose();
      this.logger.debug(`Disposed trigger: ${name}`);
    }
    this.triggers.clear();
    
    this.logger.log('TriggerService shutdown complete');
  }
}