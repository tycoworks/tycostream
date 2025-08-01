import type { Cache } from './cache.types';

/**
 * Simple cache for storing row data by primary key
 * Pure data storage with no event emission or business logic
 */
export class SimpleCache implements Cache {
  private cache = new Map<string | number, Record<string, any>>();

  constructor(
    private primaryKeyField: string
  ) {}

  /**
   * Store a row in the cache, creating a shallow copy to prevent mutations
   * Returns false if primary key is missing, true if stored successfully
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
   * Used to distinguish between insert and update operations
   */
  has(primaryKey: string | number): boolean {
    return this.cache.has(primaryKey);
  }

  /**
   * Delete a row using its primary key field
   * Returns false if primary key is missing or row not found
   */
  delete(row: Record<string, any>): boolean {
    const primaryKey = row[this.primaryKeyField];
    if (primaryKey === undefined || primaryKey === null) {
      return false;
    }
    return this.cache.delete(primaryKey);
  }

  /**
   * Get all cached rows as an array
   * Returns row references, not copies - do not mutate
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
   * Clear all cached data
   */
  clear(): void {
    this.cache.clear();
  }
}