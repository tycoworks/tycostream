import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SourceService } from './source.service';
import { ViewService } from './view.service';

/**
 * View module provides filtered real-time data views
 * Exports ViewService for GraphQL subscriptions and triggers
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    SourceService,
    ViewService
  ],
  exports: [
    ViewService  // Only export ViewService, SourceService is internal
  ],
})
export class ViewModule {}