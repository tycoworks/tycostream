import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseStreamingService } from './database-streaming.service';
import { DatabaseStreamingManagerService } from './database-streaming-manager.service';

@Module({
  providers: [
    DatabaseConnectionService, 
    DatabaseStreamingService, 
    DatabaseStreamingManagerService
  ],
  exports: [
    // Main public interface - this is what GraphQL will use
    DatabaseStreamingManagerService
    // DatabaseConnectionService and DatabaseStreamingService are internal helpers
  ],
})
export class DatabaseModule {}