import { Logger } from '@nestjs/common';
import { Observable, filter, map, share } from 'rxjs';
import { RowUpdateEvent, RowUpdateType, Filter } from './types';

/**
 * View represents a filtered subset of a data stream
 * It tracks which rows are visible and generates appropriate events
 * as rows enter or leave the view based on the filter
 */
export class View {
  private readonly logger = new Logger(`View`);
  private readonly visibleKeys = new Set<string | number>();
  private initialized = false;
  private readonly stream$: Observable<[RowUpdateEvent, bigint]>;
  
  constructor(
    private readonly viewFilter: Filter,
    private readonly primaryKeyField: string,
    sourceStream$: Observable<[RowUpdateEvent, bigint]>
  ) {
    // Create the filtered stream
    this.stream$ = sourceStream$.pipe(
      map(([event, timestamp]): [RowUpdateEvent, bigint] | null => {
        const transformed = this.processEvent(event);
        return transformed ? [transformed, timestamp] : null;
      }),
      filter((result): result is [RowUpdateEvent, bigint] => result !== null),
      share()  // Share among all subscribers
    );
  }
  
  /**
   * Check if this view has an actual filter expression
   */
  private hasFilter(): boolean {
    return this.viewFilter.expression !== '';
  }
  
  /**
   * Get filtered snapshot, building visibleKeys if needed
   */
  getSnapshot(allRows: Record<string, any>[]): Record<string, any>[] {
    // Fast path for empty filter
    if (!this.hasFilter()) {
      return allRows;
    }
    
    let result: Record<string, any>[];
    
    if (!this.initialized) {
      // First time - build visibleKeys while filtering
      result = [];
      for (const row of allRows) {
        if (this.viewFilter.evaluate(row)) {
          const key = row[this.primaryKeyField];
          this.visibleKeys.add(key);
          result.push(row);
        }
      }
      this.initialized = true;
    } else {
      // Already initialized - use visibleKeys for O(1) lookups
      result = allRows.filter(row => {
        const key = row[this.primaryKeyField];
        return this.visibleKeys.has(key);
      });
    }
    
    return result;
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
    
    // Mark as initialized if not already
    if (!this.initialized) {
      this.initialized = true;
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
   * Get the filtered stream for this view
   */
  get stream(): Observable<[RowUpdateEvent, bigint]> {
    return this.stream$;
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.visibleKeys.clear();
  }
}