import { EventEmitter } from 'events';
import { logger, truncateForLog } from './logger.js';

// Component-specific configuration
const MAX_LISTENERS = 1000; // Maximum event listeners to prevent memory leaks
import type { StreamEvent, RowUpdateEvent, CacheSubscriber, DiffType } from './types.js';

export class ViewCache extends EventEmitter {
  private static readonly MAX_LISTENERS = MAX_LISTENERS;
  private cache = new Map<any, Record<string, any>>();
  private log = logger.child({ component: 'viewCache' });

  constructor(private primaryKeyField: string, private viewName: string) {
    super();
    this.setMaxListeners(ViewCache.MAX_LISTENERS);
  }

  /**
   * Apply a stream event to the cache
   */
  applyStreamEvent(event: StreamEvent): void {
    const primaryKey = event.row[this.primaryKeyField];
    
    if (primaryKey === undefined || primaryKey === null) {
      this.log.warn('Data row missing required ID field', {
        viewName: this.viewName,
        primaryKeyField: this.primaryKeyField,
        rowKeys: Object.keys(event.row),
        suggestion: `Check that your view has a field named '${this.primaryKeyField}' with type ID!`
      });
      return;
    }

    let updateEvent: RowUpdateEvent;
    const previousRow = this.cache.get(primaryKey);

    if (event.diff === 1) {
      // Insert or update
      const isUpdate = this.cache.has(primaryKey);
      const operationType = isUpdate ? 'update' : 'insert';
      this.cache.set(primaryKey, { ...event.row });
      
      updateEvent = {
        type: operationType,
        row: { ...event.row },
        previousRow: isUpdate ? previousRow : undefined
      };
      
      const rowData = truncateForLog(event.row);
      this.log.debug(`Cache updated: ${operationType} - ${rowData}`, {
        viewName: this.viewName,
        primaryKey,
        cacheSize: this.cache.size
      });
    } else if (event.diff === -1) {
      // Delete
      this.cache.delete(primaryKey);
      
      updateEvent = {
        type: 'delete',
        row: { ...event.row },
        previousRow
      };
      
      const deletedRow = truncateForLog(event.row);
      this.log.debug(`Cache updated: delete - ${deletedRow}`, {
        viewName: this.viewName,
        primaryKey,
        cacheSize: this.cache.size
      });
    } else {
      // Unknown diff type - log and skip
      this.log.warn('Unknown diff type received', {
        viewName: this.viewName,
        diff: event.diff,
        primaryKey,
        suggestion: 'Expected diff values: 1 (insert/update) or -1 (delete)'
      });
      return;
    }

    // Notify all subscribers
    this.emit('update', updateEvent);
  }


  /**
   * Get a specific row by primary key
   */
  getRow(primaryKey: any): Record<string, any> | undefined {
    return this.cache.get(primaryKey);
  }

  /**
   * Get current cache size
   */
  size(): number {
    return this.cache.size;
  }

  /**
   * Clear the entire cache
   */
  clear(): void {
    this.cache.clear();
    this.log.debug('Cache cleared', { viewName: this.viewName });
  }

  /**
   * Get current state as array (for GraphQL Query resolver compatibility)
   * Note: Subscriptions use the subscribe() method for live streaming
   */
  getAllRows(): Record<string, any>[] {
    return Array.from(this.cache.values());
  }

  /**
   * Subscribe to cache updates
   * Immediately emits current state as individual insert events,
   * then continues with live updates
   */
  subscribe(subscriber: CacheSubscriber): () => void {
    const handler = (event: RowUpdateEvent) => {
      subscriber.onUpdate(event);
    };
    
    this.on('update', handler);
    
    this.log.debug('Cache subscriber added', {
      viewName: this.viewName,
      totalSubscribers: this.listenerCount('update'),
      currentStateSize: this.cache.size
    });
    
    // Immediately emit current state as insert events
    // Use setTimeout(0) to defer to next event loop tick, ensuring subscription is fully set up
    setTimeout(() => {
      this.log.debug('Emitting current state to new subscriber', {
        viewName: this.viewName,
        stateSize: this.cache.size
      });
      
      let emittedCount = 0;
      for (const [primaryKey, row] of this.cache) {
        const currentStateEvent: RowUpdateEvent = {
          type: 'insert',
          row: { ...row },
          previousRow: undefined
        };
        this.log.debug('Emitting cached row to subscriber', {
          primaryKey,
          emittedCount: ++emittedCount,
          totalRows: this.cache.size
        });
        subscriber.onUpdate(currentStateEvent);
      }
    }, 0);
    
    return () => {
      this.off('update', handler);
      this.log.debug('Cache subscriber removed', {
        viewName: this.viewName,
        totalSubscribers: this.listenerCount('update')
      });
    };
  }

}