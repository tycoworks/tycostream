import { Observable, Subject } from 'rxjs';
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
  private readonly output$ = new Subject<RowUpdateEvent>();
  
  constructor(
    private readonly source$: Observable<RowUpdateEvent>,
    private readonly filter: Filter | null,
    private readonly primaryKeyField: string,
    private readonly getRow: (key: string | number) => any | undefined
  ) {
    // Subscribe to source and process events
    this.source$.subscribe({
      next: (event) => this.processEvent(event),
      error: (err) => this.output$.error(err),
      complete: () => this.output$.complete()
    });
  }
  
  /**
   * Get the filtered stream of events
   */
  getUpdates(): Observable<RowUpdateEvent> {
    return this.output$.asObservable();
  }
  
  /**
   * Process an event from the source stream
   */
  private processEvent(event: RowUpdateEvent): void {
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
        // Row entering view
        outputEvent = { type: RowUpdateType.Insert, row: this.getFullRow(event) };
      } else if (wasInView && !isInView) {
        // Row leaving view
        outputEvent = { type: RowUpdateType.Delete, row: { [this.primaryKeyField]: key } };
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
    
    // Emit event if there's a transition we care about
    if (outputEvent) {
      this.output$.next(outputEvent);
    }
  }
  
  /**
   * Get the full row for an event
   */
  private getFullRow(event: RowUpdateEvent): any {
    if (event.type === RowUpdateType.Insert) {
      return event.row;
    } else {
      const key = event.row[this.primaryKeyField];
      return this.getRow(key);
    }
  }
  
  /**
   * Determine if a row should be in the view
   */
  private shouldBeInView(event: RowUpdateEvent, wasInView: boolean): boolean {
    const fullRow = this.getFullRow(event);
    
    // Optimization: For UPDATE events where filter fields haven't changed
    if (event.type === RowUpdateType.Update && this.filter && wasInView) {
      const changedFields = Object.keys(event.row);
      const hasRelevantChanges = changedFields.some(field => this.filter!.fields.has(field));
      
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
    this.output$.complete();
    this.visibleKeys.clear();
  }
}