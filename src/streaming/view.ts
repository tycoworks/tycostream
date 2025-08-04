import { Logger } from '@nestjs/common';
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
  
  constructor(
    private readonly filter: Filter | null,
    private readonly primaryKeyField: string
  ) {
    // Pure transformer - no streams or subscriptions
  }
  
  /**
   * Get filtered snapshot, building visibleKeys if needed
   */
  getSnapshot(allRows: Record<string, any>[]): Record<string, any>[] {
    let result: Record<string, any>[];
    
    if (!this.filter) {
      // No filter = all rows visible
      result = allRows;
    } else if (!this.initialized) {
      // First time - build visibleKeys while filtering
      result = [];
      for (const row of allRows) {
        if (this.filter.evaluate(row)) {
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
    if (event.type === RowUpdateType.Update && this.filter && wasInView) {
      const hasRelevantChanges = Array.from(event.fields).some(field => this.filter!.fields.has(field));
      
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
    if (!this.filter) {
      // No filter means all rows match
      return true;
    }
    
    try {
      return this.filter.evaluate(row);
    } catch (error) {
      this.logger.error(`Filter evaluation error: ${error.message}`, error.stack);
      // On error, exclude the row from view
      return false;
    }
  }
  
  /**
   * Clean up resources
   */
  dispose(): void {
    this.visibleKeys.clear();
  }
}