import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service';

/**
 * Database module provides database infrastructure services
 * Exports DatabaseConnectionService for use by streaming module
 */
@Module({
  providers: [
    DatabaseConnectionService
  ],
  exports: [
    DatabaseConnectionService
  ],
})
export class DatabaseModule {}