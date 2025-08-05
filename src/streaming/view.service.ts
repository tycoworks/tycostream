import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import { StreamingManagerService } from './manager.service';
import { View } from './view';
import type { RowUpdateEvent, Filter } from './types';

/**
 * Empty filter that matches all rows
 */
const EMPTY_FILTER: Filter = {
  expression: '',
  fields: new Set<string>(),
  evaluate: () => true
};

/**
 * ViewService manages views of streaming data
 * Views can filter, transform, and reorder data
 * This is the main interface for GraphQL subscriptions
 */
@Injectable()
export class ViewService implements OnModuleDestroy {
  private readonly logger = new Logger(ViewService.name);
  // Cache views by source:filterExpression key
  private readonly viewCache = new Map<string, View>();

  constructor(
    private streamingManager: StreamingManagerService
  ) {}

  /**
   * Get updates for a specific source with optional filtering
   */
  getUpdates(sourceName: string, filter?: Filter | null): Observable<RowUpdateEvent> {
    // Normalize null/undefined filters to EMPTY_FILTER
    const viewFilter = filter || EMPTY_FILTER;
    
    // Get or create view for this source + filter combination
    const cacheKey = `${sourceName}:${viewFilter.expression}`;
    let view = this.viewCache.get(cacheKey);
    
    if (!view) {
      // Get the streaming service for this source
      const streamingService = this.streamingManager.getStreamingService(sourceName);
      
      // Create a new view with the streaming service
      view = new View(viewFilter, streamingService);
      
      this.viewCache.set(cacheKey, view);
      this.logger.debug(`Created new view for source: ${sourceName}, filter: ${viewFilter.expression || '(empty)'}`);
    }
    
    // Return the view's filtered updates
    return view.getUpdates();
  }

  /**
   * Clean up resources on module destroy
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down ViewService...');
    
    // Dispose all cached views
    const disposePromises = Array.from(this.viewCache.values()).map(
      view => Promise.resolve(view.dispose())
    );
    await Promise.all(disposePromises);
    this.viewCache.clear();
    
    this.logger.log('ViewService shutdown complete');
  }
}