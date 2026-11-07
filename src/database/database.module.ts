import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseStreamService } from './stream.service.js';

/**
 * Database module provides database infrastructure services
 * Exports DatabaseStreamService for use by streaming module
 */
@Module({
  providers: [DatabaseConnectionService, DatabaseStreamService],
  exports: [DatabaseStreamService],
})
export class DatabaseModule {}
