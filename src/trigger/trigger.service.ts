import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { buildExpression } from '../common/expressions';
import { Trigger, TriggerCondition } from './trigger';
import { CreateTriggerDto } from './trigger.dto';

/**
 * Service for managing triggers registry
 * Step 2: Just stores triggers in memory, no streaming yet
 */
@Injectable()
export class TriggerService {
  private readonly logger = new Logger(TriggerService.name);
  private readonly triggers = new Map<string, Trigger>();

  constructor() {}

  /**
   * Create a new trigger
   */
  async create(dto: CreateTriggerDto): Promise<Trigger> {
    // Check for duplicate
    if (this.triggers.has(dto.name)) {
      throw new ConflictException(`Trigger with name '${dto.name}' already exists`);
    }

    // Compile conditions to Expressions
    const matchCondition: TriggerCondition = {
      condition: buildExpression(dto.match.condition),
      webhook: dto.match.webhook
    };

    const unmatchCondition = dto.unmatch ? {
      condition: buildExpression(dto.unmatch.condition),
      webhook: dto.unmatch.webhook
    } : undefined;

    // Create trigger
    const trigger = new Trigger({
      name: dto.name,
      source: dto.source,
      match: matchCondition,
      unmatch: unmatchCondition
    });

    // Store trigger
    this.triggers.set(trigger.name, trigger);
    this.logger.log(`Created trigger '${trigger.name}' for source '${trigger.source}'`);

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
    
    // Remove from registry
    this.triggers.delete(name);
    this.logger.log(`Deleted trigger '${name}'`);
  }
}