import { Controller, Post, Get, Delete, Body, Param, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { TriggerService } from './trigger.service';
import { CreateTriggerDto } from './trigger.dto';
import { Trigger } from './trigger';

/**
 * REST API controller for trigger management
 */
@Controller()
export class TriggerController {
  private readonly logger = new Logger(TriggerController.name);

  constructor(private readonly triggerService: TriggerService) {}

  /**
   * Create a new trigger
   * POST /triggers
   */
  @Post('triggers')
  async createTrigger(@Body() dto: CreateTriggerDto): Promise<Trigger> {
    this.logger.log(`Creating trigger: ${dto.name}`);
    return this.triggerService.create(dto);
  }

  /**
   * List all triggers
   * GET /triggers
   */
  @Get('triggers')
  async getAll(): Promise<Trigger[]> {
    return this.triggerService.getAll();
  }

  /**
   * Get a specific trigger
   * GET /triggers/:name
   */
  @Get('triggers/:name')
  async get(@Param('name') name: string): Promise<Trigger> {
    return this.triggerService.get(name);
  }

  /**
   * Delete a trigger
   * DELETE /triggers/:name
   */
  @Delete('triggers/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTrigger(@Param('name') name: string): Promise<void> {
    this.logger.log(`Deleting trigger: ${name}`);
    await this.triggerService.delete(name);
  }
}