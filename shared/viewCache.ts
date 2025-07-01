import { logger } from './logger.js';
import type { StreamEvent } from './types.js';

export class ViewCache {
  private cache = new Map<any, Record<string, any>>();
  private log = logger.child({ component: 'viewCache' });

  constructor(private primaryKeyField: string, private viewName: string) {}

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

    if (event.diff === 1) {
      // Insert or update
      this.cache.set(primaryKey, { ...event.row });
      this.log.debug('Cache updated: upsert', {
        viewName: this.viewName,
        primaryKey,
        cacheSize: this.cache.size
      });
    } else if (event.diff === -1) {
      // Delete
      this.cache.delete(primaryKey);
      this.log.debug('Cache updated: delete', {
        viewName: this.viewName,
        primaryKey,
        cacheSize: this.cache.size
      });
    }
  }

  /**
   * Get current snapshot of all cached rows in insertion order
   */
  getSnapshot(): Record<string, any>[] {
    return Array.from(this.cache.values());
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
}