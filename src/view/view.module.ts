import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ViewService } from './view.service.js';

/**
 * View module provides filtered real-time data views
 * Exports ViewService for GraphQL subscriptions
 */
@Module({
  imports: [DatabaseModule],
  providers: [ViewService],
  exports: [ViewService],
})
export class ViewModule {}
