import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Observable } from 'rxjs';
import { SourceService } from './source.service';
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

  constructor(
    private sourceService: SourceService
  ) {}

  /**
   * Get updates for a specific source with optional filtering
   */
  getUpdates(sourceName: string, filter?: Filter | null): Observable<RowUpdateEvent> {
    // Normalize null/undefined filters to EMPTY_FILTER
    const viewFilter = filter || EMPTY_FILTER;
    
    // Get the source for this data source
    const source = this.sourceService.getSource(sourceName);
    
    // Create a new view for each subscriber (no caching)
    const view = new View(viewFilter, source);
    
    this.logger.debug(`Created new view for source: ${sourceName}, filter: ${viewFilter.expression || '(empty)'}`);
    
    // Return the view's filtered updates with cleanup
    return this.createViewStream(view);
  }

  /**
   * Create a stream that disposes view on disconnect
   */
  private createViewStream(view: View): Observable<RowUpdateEvent> {
    return new Observable<RowUpdateEvent>(subscriber => {
      // Subscribe to the view's updates
      const subscription = view.getUpdates().subscribe(subscriber);
      
      // Return cleanup function
      return () => {
        subscription.unsubscribe();
        // Dispose the view (each subscriber has their own)
        view.dispose();
      };
    });
  }

  /**
   * Clean up resources on module destroy
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down ViewService...');
    // Views are disposed per-subscriber, nothing to clean up here
    this.logger.log('ViewService shutdown complete');
  }
}