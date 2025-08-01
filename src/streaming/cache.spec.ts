import { SimpleCache } from './cache';

describe('SimpleCache', () => {
  let cache: SimpleCache;

  beforeEach(() => {
    cache = new SimpleCache('id');
  });

  describe('basic operations', () => {
    it('should store and retrieve items', () => {
      const row = { id: '1', name: 'Test Item', value: 42 };
      const result = cache.set(row);
      
      expect(result).toBe(true);
      expect(cache.get('1')).toEqual(row);
      expect(cache.has('1')).toBe(true);
      expect(cache.size).toBe(1);
    });

    it('should handle different primary key fields', () => {
      const customCache = new SimpleCache('userId');
      const row = { userId: 'abc123', name: 'User' };
      customCache.set(row);
      
      expect(customCache.get('abc123')).toEqual(row);
    });

    it('should update existing items', () => {
      const row1 = { id: '1', name: 'Original' };
      const row2 = { id: '1', name: 'Updated' };
      
      cache.set(row1);
      cache.set(row2);
      
      expect(cache.get('1')).toEqual(row2);
      expect(cache.size).toBe(1);
    });

    it('should delete items', () => {
      const row = { id: '1', name: 'Test' };
      cache.set(row);
      
      expect(cache.delete(row)).toBe(true);
      expect(cache.has('1')).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should return false when deleting non-existent items', () => {
      expect(cache.delete({ id: 'nonexistent' })).toBe(false);
    });

    it('should return false when deleting without primary key', () => {
      expect(cache.delete({ name: 'No ID' })).toBe(false);
      expect(cache.delete({ id: null })).toBe(false);
      expect(cache.delete({ id: undefined })).toBe(false);
    });

    it('should clear all items', () => {
      cache.set({ id: '1', name: 'Item 1' });
      cache.set({ id: '2', name: 'Item 2' });
      cache.set({ id: '3', name: 'Item 3' });
      
      expect(cache.size).toBe(3);
      cache.clear();
      expect(cache.size).toBe(0);
      expect(cache.getAllRows()).toEqual([]);
    });

    it('should get all rows', () => {
      const rows = [
        { id: '1', name: 'Item 1' },
        { id: '2', name: 'Item 2' },
        { id: '3', name: 'Item 3' }
      ];
      
      rows.forEach(row => cache.set(row));
      
      const allRows = cache.getAllRows();
      expect(allRows).toHaveLength(3);
      expect(allRows).toEqual(expect.arrayContaining(rows));
    });

    it('should handle numeric primary keys', () => {
      const row = { id: 123, name: 'Numeric ID' };
      cache.set(row);
      
      expect(cache.get(123)).toEqual(row);
      expect(cache.get('123')).toBeUndefined(); // Map uses strict equality
    });

    it('should return undefined for non-existent items', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });
  });


  describe('edge cases', () => {
    it('should handle rows without primary key field', () => {
      const row = { name: 'No ID', value: 123 };
      
      const result = cache.set(row);
      expect(result).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should handle null/undefined primary key values', () => {
      expect(cache.set({ id: null, name: 'Null ID' })).toBe(false);
      expect(cache.set({ id: undefined, name: 'Undefined ID' })).toBe(false);
      expect(cache.size).toBe(0);
    });

    it('should handle empty cache operations', () => {
      expect(cache.getAllRows()).toEqual([]);
      expect(cache.size).toBe(0);
      expect(() => cache.clear()).not.toThrow();
    });

    it('should create independent copies when storing', () => {
      const row = { id: '1', name: 'Original' };
      cache.set(row);
      
      // Modify original
      row.name = 'Modified';
      
      // Cache should have the original value
      expect(cache.get('1')).toEqual({ id: '1', name: 'Original' });
    });
  });
});