import { Controller, Post, Get, Delete, Body, Param, HttpCode, HttpStatus, Logger, NotImplementedException } from '@nestjs/common';
import { CreateTriggerDto } from './trigger.dto';

/**
 * REST API controller for trigger management
 * TODO: Will be moved to api module and connected to WebhookService
 */
@Controller()
export class TriggerController {
  private readonly logger = new Logger(TriggerController.name);

  constructor() {}

  /**
   * Create a new trigger
   * POST /triggers
   */
  @Post('triggers')
  async createTrigger(@Body() dto: CreateTriggerDto): Promise<any> {
    this.logger.log(`Creating trigger: ${dto.name}`);
    throw new NotImplementedException('Triggers will be implemented in api module');
  }

  /**
   * List all triggers
   * GET /triggers
   */
  @Get('triggers')
  async getAll(): Promise<any[]> {
    throw new NotImplementedException('Triggers will be implemented in api module');
  }

  /**
   * Get a specific trigger
   * GET /triggers/:name
   */
  @Get('triggers/:name')
  async get(@Param('name') name: string): Promise<any> {
    throw new NotImplementedException('Triggers will be implemented in api module');
  }

  /**
   * Delete a trigger
   * DELETE /triggers/:name
   */
  @Delete('triggers/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteTrigger(@Param('name') name: string): Promise<void> {
    this.logger.log(`Deleting trigger: ${name}`);
    throw new NotImplementedException('Triggers will be implemented in api module');
  }
}