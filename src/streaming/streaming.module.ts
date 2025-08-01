import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { StreamingManagerService } from './manager.service';

/**
 * Streaming module provides real-time data streaming functionality
 * Exports StreamingManagerService for GraphQL subscriptions to consume
 */
@Module({
  imports: [DatabaseModule],
  providers: [
    StreamingManagerService
  ],
  exports: [
    StreamingManagerService
  ],
})
export class StreamingModule {}