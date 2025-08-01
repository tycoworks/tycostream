/**
 * Interface for cache implementations
 * Allows swapping between different cache strategies (memory, Redis, etc.)
 */
export interface Cache {
  /**
   * Store or update a row in the cache
   */
  set(row: Record<string, any>): boolean;

  /**
   * Get a row by primary key
   */
  get(primaryKey: string | number): Record<string, any> | undefined;

  /**
   * Check if a primary key exists
   */
  has(primaryKey: string | number): boolean;

  /**
   * Delete a row
   */
  delete(row: Record<string, any>): boolean;

  /**
   * Get all rows as an array
   */
  getAllRows(): Record<string, any>[];

  /**
   * Get cache size
   */
  readonly size: number;

  /**
   * Clear all data
   */
  clear(): void;
}