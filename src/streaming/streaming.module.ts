import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { SourceService } from './manager.service';
import { ViewService } from './view.service';

/**
 * Streaming module provides real-time data streaming functionality
 * Exports ViewService for GraphQL subscriptions to consume
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    SourceService,
    ViewService
  ],
  exports: [
    ViewService
  ],
})
export class StreamingModule {}