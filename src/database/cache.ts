import type { Cache } from './cache.types';

/**
 * Simple cache for storing row data by primary key
 * Pure data storage with no event emission or business logic
 */
export class SimpleCache implements Cache {
  private cache = new Map<any, Record<string, any>>();

  constructor(
    private primaryKeyField: string
  ) {}

  /**
   * Store a row in the cache
   */
  set(row: Record<string, any>): boolean {
    const primaryKey = row[this.primaryKeyField];
    if (primaryKey === undefined || primaryKey === null) {
      return false;
    }

    this.cache.set(primaryKey, { ...row });
    return true;
  }

  /**
   * Get a row by primary key
   */
  get(primaryKey: string | number): Record<string, any> | undefined {
    return this.cache.get(primaryKey);
  }

  /**
   * Check if a primary key exists
   */
  has(primaryKey: string | number): boolean {
    return this.cache.has(primaryKey);
  }

  /**
   * Delete a row by primary key
   */
  delete(row: Record<string, any>): boolean {
    const primaryKey = row[this.primaryKeyField];
    if (primaryKey === undefined || primaryKey === null) {
      return false;
    }
    return this.cache.delete(primaryKey);
  }

  /**
   * Get all rows as an array
   */
  getAllRows(): Record<string, any>[] {
    return Array.from(this.cache.values());
  }


  /**
   * Get cache size
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Clear all data
   */
  clear(): void {
    this.cache.clear();
  }
}