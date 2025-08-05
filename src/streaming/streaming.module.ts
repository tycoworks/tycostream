import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StreamingManagerService } from './manager.service';
import { ViewService } from './view.service';

/**
 * Streaming module provides real-time data streaming functionality
 * Exports ViewService for GraphQL subscriptions to consume
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    StreamingManagerService,
    ViewService
  ],
  exports: [
    ViewService
  ],
})
export class StreamingModule {}