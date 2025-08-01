import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseStreamingManagerService } from './database-streaming-manager.service';

/**
 * Database module encapsulates all database streaming functionality
 * Exports only DatabaseStreamingManagerService to enforce proper layering
 */
@Module({
  providers: [
    DatabaseConnectionService, 
    DatabaseStreamingManagerService
  ],
  exports: [
    DatabaseStreamingManagerService
  ],
})
export class DatabaseModule {}