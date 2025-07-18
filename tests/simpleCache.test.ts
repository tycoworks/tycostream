import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SimpleCache } from '../src/database/cache.js';
import { createTestCache, TestData } from './test-utils.js';

describe('SimpleCache', () => {
  let cache: SimpleCache;
  const primaryKeyField = 'id';

  beforeEach(() => {
    cache = createTestCache(primaryKeyField);
  });

  it('should initialize empty cache', () => {
    expect(cache.size).toBe(0);
    expect(cache.getAllRows()).toEqual([]);
    expect(cache.timestamp).toBe(BigInt(0));
  });

  it('should store and retrieve rows', () => {
    const row = TestData.basicRow('123', 'test', 42.5);
    const timestamp = BigInt(1000);

    cache.set(row, timestamp);

    expect(cache.size).toBe(1);
    expect(cache.get('123')).toEqual(row);
    expect(cache.getAllRows()).toEqual([row]);
    expect(cache.timestamp).toBe(timestamp);
  });

  it('should update existing rows', () => {
    // Insert initial row
    cache.set({ id: '123', name: 'test', value: 42.5 }, BigInt(1000));

    // Update the same row
    const updatedRow = { id: '123', name: 'updated', value: 99.9 };
    const newTimestamp = BigInt(2000);
    cache.set(updatedRow, newTimestamp);

    expect(cache.size).toBe(1);
    expect(cache.get('123')).toEqual(updatedRow);
    expect(cache.timestamp).toBe(newTimestamp);
  });

  it('should delete rows', () => {
    const row = { id: '123', name: 'test', value: 42.5 };
    cache.set(row, BigInt(1000));
    
    expect(cache.size).toBe(1);
    
    const deleted = cache.delete(row);
    
    expect(deleted).toBe(true);
    expect(cache.size).toBe(0);
    expect(cache.get('123')).toBeUndefined();
  });

  it('should return false when deleting non-existent row', () => {
    const deleted = cache.delete({ id: '999', name: 'non-existent' });
    expect(deleted).toBe(false);
  });

  it('should handle multiple rows', () => {
    const rows = TestData.multipleRows(3);
    
    rows.forEach((row, index) => {
      cache.set(row, BigInt(1000 + index));
    });

    expect(cache.size).toBe(3);
    expect(cache.getAllRows()).toHaveLength(3);
    expect(cache.get('1')).toEqual(rows[0]);
    expect(cache.get('2')).toEqual(rows[1]);
    expect(cache.get('3')).toEqual(rows[2]);
    // Should have the last timestamp
    expect(cache.timestamp).toBe(BigInt(1002));
  });

  it('should check if row exists with has()', () => {
    cache.set({ id: '123', name: 'test' }, BigInt(1000));
    
    expect(cache.has('123')).toBe(true);
    expect(cache.has('999')).toBe(false);
  });

  it('should clear all data', () => {
    // Add some data
    cache.set({ id: '1', name: 'first' }, BigInt(1000));
    cache.set({ id: '2', name: 'second' }, BigInt(2000));
    
    expect(cache.size).toBe(2);
    
    cache.clear();
    
    expect(cache.size).toBe(0);
    expect(cache.getAllRows()).toEqual([]);
  });

  it('should handle rows with missing primary key', () => {
    // Row without primary key should not be added
    const rowWithoutKey = { name: 'test', value: 42 };
    const result = cache.set(rowWithoutKey, BigInt(1000));
    
    expect(result).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('should handle null/undefined primary key', () => {
    // Rows with null/undefined primary key should not be added
    const result1 = cache.set({ id: null, name: 'test' }, BigInt(1000));
    const result2 = cache.set({ id: undefined, name: 'test2' }, BigInt(2000));
    
    expect(result1).toBe(false);
    expect(result2).toBe(false);
    expect(cache.size).toBe(0);
  });


  it('should store copy of row data', () => {
    const originalRow = { id: '123', name: 'test', value: 42 };
    cache.set(originalRow, BigInt(1000));
    
    // Modify original
    originalRow.name = 'modified';
    
    // Cache should still have original value
    expect(cache.get('123')).toEqual({ id: '123', name: 'test', value: 42 });
  });

  it('should track latest timestamp across operations', () => {
    cache.set({ id: '1', name: 'first' }, BigInt(1000));
    expect(cache.timestamp).toBe(BigInt(1000));
    
    cache.set({ id: '2', name: 'second' }, BigInt(500)); // Earlier timestamp
    expect(cache.timestamp).toBe(BigInt(500)); // Still updates to latest set operation
    
    cache.set({ id: '3', name: 'third' }, BigInt(2000));
    expect(cache.timestamp).toBe(BigInt(2000));
  });
});