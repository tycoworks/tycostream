import { EventEmitter } from 'events';
import { logger, truncateForLog } from '../shared/logger.js';
import type { ViewCache, StreamEvent, RowUpdateEvent, CacheSubscriber } from '../shared/viewCache.js';

// Component-specific configuration
const MAX_LISTENERS = 1000; // Maximum event listeners to prevent memory leaks

export class EventEmitterViewCache extends EventEmitter implements ViewCache {
  private static readonly MAX_LISTENERS = MAX_LISTENERS;
  private cache = new Map<any, { row: Record<string, any>, timestamp: bigint }>();
  private log = logger.child({ component: 'viewCache' });

  constructor(private primaryKeyField: string, private viewName: string) {
    super();
    this.setMaxListeners(EventEmitterViewCache.MAX_LISTENERS);
  }

  /**
   * Apply a stream event to the cache
   */
  handleRowUpdate(event: StreamEvent): void {
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

    if (event.diff === 1) {
      // Insert or update
      const isUpdate = this.cache.has(primaryKey);
      const operationType = isUpdate ? 'update' : 'insert';
      this.cache.set(primaryKey, { row: { ...event.row }, timestamp: event.timestamp });
      
      updateEvent = {
        type: operationType,
        row: { ...event.row }
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
        row: { ...event.row }
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
    const entry = this.cache.get(primaryKey);
    return entry?.row;
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
    return Array.from(this.cache.values()).map(entry => entry.row);
  }

  getSubscriberCount(event: string): number {
    return this.listenerCount(event);
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
      totalSubscribers: this.getSubscriberCount('update'),
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
      for (const [primaryKey, entry] of this.cache) {
        const currentStateEvent: RowUpdateEvent = {
          type: 'insert',
          row: { ...entry.row }
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
        totalSubscribers: this.getSubscriberCount('update')
      });
    };
  }

}