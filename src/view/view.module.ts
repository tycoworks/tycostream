import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { SourceService } from './source.service.js';
import { ViewService } from './view.service.js';

/**
 * View module provides filtered real-time data views
 * Exports ViewService for GraphQL subscriptions
 */
@Module({
  imports: [DatabaseModule],
  providers: [SourceService, ViewService],
  exports: [
    ViewService, // Only export ViewService, SourceService is internal
  ],
})
export class ViewModule {}
