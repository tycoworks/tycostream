import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './database-connection.service';
import { DatabaseStreamingService } from './database-streaming.service';

@Module({
  providers: [DatabaseConnectionService, DatabaseStreamingService],
  exports: [DatabaseConnectionService, DatabaseStreamingService],
})
export class DatabaseModule {}