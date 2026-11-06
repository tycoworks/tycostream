import { Module } from '@nestjs/common';
import { DatabaseStreamService } from './stream.service.js';

/**
 * Database module provides database infrastructure services
 * Exports DatabaseStreamService for use by streaming module
 */
@Module({
  providers: [DatabaseStreamService],
  exports: [DatabaseStreamService],
})
export class DatabaseModule {}
