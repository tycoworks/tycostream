import { describe, it, expect, beforeEach } from 'vitest';
import { ViewCache } from '../shared/viewCache.js';
import type { StreamEvent } from '../shared/types.js';

describe('ViewCache', () => {
  let cache: ViewCache;
  const primaryKeyField = 'id';
  const viewName = 'test_view';

  beforeEach(() => {
    cache = new ViewCache(primaryKeyField, viewName);
  });

  it('should initialize empty cache', () => {
    expect(cache.size()).toBe(0);
    expect(cache.getSnapshot()).toEqual([]);
  });

  it('should handle insert events (diff = 1)', () => {
    const insertEvent: StreamEvent = {
      row: { id: '123', name: 'test', value: 42.5 },
      diff: 1,
    };

    cache.applyStreamEvent(insertEvent);

    expect(cache.size()).toBe(1);
    expect(cache.getRow('123')).toEqual({ id: '123', name: 'test', value: 42.5 });
    expect(cache.getSnapshot()).toEqual([{ id: '123', name: 'test', value: 42.5 }]);
  });

  it('should handle update events (diff = 1)', () => {
    // Insert initial row
    cache.applyStreamEvent({
      row: { id: '123', name: 'test', value: 42.5 },
      diff: 1,
    });

    // Update the same row
    const updateEvent: StreamEvent = {
      row: { id: '123', name: 'updated', value: 99.9 },
      diff: 1,
    };

    cache.applyStreamEvent(updateEvent);

    expect(cache.size()).toBe(1);
    expect(cache.getRow('123')).toEqual({ id: '123', name: 'updated', value: 99.9 });
  });

  it('should handle delete events (diff = -1)', () => {
    // Insert initial row
    cache.applyStreamEvent({
      row: { id: '123', name: 'test', value: 42.5 },
      diff: 1,
    });

    expect(cache.size()).toBe(1);

    // Delete the row
    const deleteEvent: StreamEvent = {
      row: { id: '123', name: 'test', value: 42.5 },
      diff: -1,
    };

    cache.applyStreamEvent(deleteEvent);

    expect(cache.size()).toBe(0);
    expect(cache.getRow('123')).toBeUndefined();
    expect(cache.getSnapshot()).toEqual([]);
  });

  it('should handle multiple rows', () => {
    const events: StreamEvent[] = [
      { row: { id: '1', name: 'first', value: 10 }, diff: 1 },
      { row: { id: '2', name: 'second', value: 20 }, diff: 1 },
      { row: { id: '3', name: 'third', value: 30 }, diff: 1 },
    ];

    events.forEach(event => cache.applyStreamEvent(event));

    expect(cache.size()).toBe(3);
    expect(cache.getSnapshot()).toHaveLength(3);
    expect(cache.getRow('2')).toEqual({ id: '2', name: 'second', value: 20 });
  });

  it('should handle events with missing primary key gracefully', () => {
    const invalidEvent: StreamEvent = {
      row: { name: 'no-id', value: 42.5 }, // Missing 'id' field
      diff: 1,
    };

    // Should not throw, but also should not add to cache
    cache.applyStreamEvent(invalidEvent);
    expect(cache.size()).toBe(0);
  });

  it('should clear cache completely', () => {
    // Add some data
    cache.applyStreamEvent({
      row: { id: '123', name: 'test', value: 42.5 },
      diff: 1,
    });

    expect(cache.size()).toBe(1);

    cache.clear();

    expect(cache.size()).toBe(0);
    expect(cache.getSnapshot()).toEqual([]);
  });
});