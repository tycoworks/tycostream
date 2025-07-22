import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseStreamingManagerService } from './database-streaming-manager.service';

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