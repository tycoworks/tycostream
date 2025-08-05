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
  // Track subscriber count per view
  private readonly subscriberCounts = new Map<string, number>();

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
    
    // Return the view's filtered updates with subscriber tracking
    return this.createTrackedStream(view, cacheKey);
  }

  /**
   * Create a stream that tracks subscriber count
   */
  private createTrackedStream(view: View, cacheKey: string): Observable<RowUpdateEvent> {
    return new Observable<RowUpdateEvent>(subscriber => {
      // Increment subscriber count
      const currentCount = this.subscriberCounts.get(cacheKey) || 0;
      this.subscriberCounts.set(cacheKey, currentCount + 1);
      this.logger.debug(`Subscriber connected - view: ${cacheKey}, subscribers: ${currentCount + 1}`);
      
      // Subscribe to the view's updates
      const subscription = view.getUpdates().subscribe(subscriber);
      
      // Return cleanup function
      return () => {
        subscription.unsubscribe();
        
        // Decrement subscriber count
        const count = this.subscriberCounts.get(cacheKey) || 0;
        const newCount = Math.max(0, count - 1);
        this.subscriberCounts.set(cacheKey, newCount);
        this.logger.debug(`Subscriber disconnected - view: ${cacheKey}, subscribers: ${newCount}`);
        
        // TODO: Clean up view when no subscribers remain
        // This is part of the roadmap item: "Clear cache and close DB connection when last subscriber disconnects"
        if (newCount === 0) {
          // For now, just log it. Full cleanup chain will be implemented later
          this.logger.debug(`View ${cacheKey} has no subscribers - cleanup would happen here`);
        }
      };
    });
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
    this.subscriberCounts.clear();
    
    this.logger.log('ViewService shutdown complete');
  }
}