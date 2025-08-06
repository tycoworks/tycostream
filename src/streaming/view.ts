import { Logger } from '@nestjs/common';
import { Observable, filter, map } from 'rxjs';
import { RowUpdateEvent, RowUpdateType, Filter } from './types';
import type { StreamingService } from './streaming.service';

/**
 * View represents a filtered subset of a data stream
 * It tracks which rows are visible and generates appropriate events
 * as rows enter or leave the view based on the filter
 */
export class View {
  private readonly logger = new Logger(`View`);
  private readonly visibleKeys = new Set<string | number>();
  private readonly stream$: Observable<RowUpdateEvent>;
  private readonly primaryKeyField: string;
  
  constructor(
    private readonly viewFilter: Filter,
    private readonly streamingService: StreamingService
  ) {
    this.primaryKeyField = streamingService.getPrimaryKeyField();
    
    // Create the filtered stream from the unified stream (snapshot + live)
    
    this.stream$ = streamingService.getUpdates().pipe(
      map(event => this.processEvent(event)),
      filter((event): event is RowUpdateEvent => event !== null)
    );
  }
  
  /**
   * Check if this view has an actual filter expression
   */
  private hasFilter(): boolean {
    return this.viewFilter.expression !== '';
  }
  
  /**
   * Process an event through this view, updating visibility state
   * Returns transformed event or null if filtered out
   */
  processEvent(event: RowUpdateEvent): RowUpdateEvent | null {
    // Fast path for empty filter
    if (!this.hasFilter()) {
      return event;
    }
    
    const key = event.row[this.primaryKeyField];
    const wasInView = this.visibleKeys.has(key);
    
    let isInView: boolean;
    let outputEvent: RowUpdateEvent | null;
    
    if (event.type === RowUpdateType.Delete) {
      isInView = false;
      outputEvent = wasInView ? event : null;
    } else {
      // INSERT/UPDATE events
      isInView = this.shouldBeInView(event, wasInView);
      
      if (!wasInView && isInView) {
        // Row entering view - send as INSERT with all fields
        outputEvent = { type: RowUpdateType.Insert, fields: new Set(Object.keys(event.row)), row: event.row };
      } else if (wasInView && !isInView) {
        // Row leaving view - send as DELETE with just primary key
        outputEvent = { type: RowUpdateType.Delete, fields: new Set([this.primaryKeyField]), row: event.row };
      } else if (wasInView && isInView) {
        // Row still in view
        outputEvent = event;
      } else {
        // Not in view before or after
        outputEvent = null;
      }
    }
    
    // Update visible keys based on new state
    if (isInView) {
      this.visibleKeys.add(key);
    } else {
      this.visibleKeys.delete(key);
    }
    
    return outputEvent;
  }
  
  /**
   * Determine if a row should be in the view
   */
  private shouldBeInView(event: RowUpdateEvent, wasInView: boolean): boolean {
    const fullRow = event.row;
    
    // Optimization: For UPDATE events where filter fields haven't changed
    if (event.type === RowUpdateType.Update && wasInView) {
      const hasRelevantChanges = Array.from(event.fields).some(field => this.viewFilter.fields.has(field));
      
      if (!hasRelevantChanges) {
        return wasInView; // Filter result can't have changed
      }
    }
    
    return this.matchesFilter(fullRow);
  }
  
  /**
   * Check if a row matches the filter
   */
  private matchesFilter(row: any): boolean {
    try {
      return this.viewFilter.evaluate(row);
    } catch (error) {
      this.logger.error(`Filter evaluation error: ${error.message}`, error.stack);
      // On error, exclude the row from view
      return false;
    }
  }
  
  /**
   * Get filtered updates from this view
   */
  getUpdates(): Observable<RowUpdateEvent> {
    return this.stream$;
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.visibleKeys.clear();
  }
}