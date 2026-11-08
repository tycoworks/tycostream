import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseService } from './database.service.js';
import { MaterializeAdapter } from './materialize.js';
import { DatabaseAdapter } from './types.js';

/**
 * Database module provides database infrastructure services
 * Exports DatabaseService for use by the view layer. The adapter provider is
 * where the database is chosen.
 */
@Module({
  providers: [
    DatabaseConnectionService,
    { provide: DatabaseAdapter, useClass: MaterializeAdapter },
    DatabaseService,
  ],
  exports: [DatabaseService],
})
export class DatabaseModule {}
