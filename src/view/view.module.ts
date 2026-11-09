import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ViewService } from './view.service.js';

/**
 * View module provides views of sources: the rows a client selects
 * Exports ViewService for the API's queries and subscriptions
 */
@Module({
  imports: [DatabaseModule],
  providers: [ViewService],
  exports: [ViewService],
})
export class ViewModule {}
