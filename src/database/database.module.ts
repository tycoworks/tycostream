import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseService } from './database.service.js';
import { materializeDriver } from './materialize.js';
import { DatabaseDriver } from './types.js';

/**
 * Database module provides database infrastructure services
 * Exports DatabaseService for use by the view layer. The driver provider is
 * where the database is chosen.
 */
@Module({
  providers: [
    DatabaseConnectionService,
    { provide: DatabaseDriver, useValue: materializeDriver },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
