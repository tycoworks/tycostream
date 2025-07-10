import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ViewCache } from '../shared/viewCache.js';
import type { StreamEvent, RowUpdateEvent, CacheSubscriber } from '../shared/types.js';
import { createTestCache, TestData, TEST_DELAYS, createMockSubscriber } from './test-utils.js';

describe('ViewCache', () => {
  let cache: ViewCache;

  beforeEach(() => {
    cache = createTestCache();
  });

  it('should initialize empty cache', () => {
    expect(cache.size()).toBe(0);
    expect(cache.getAllRows()).toEqual([]);
  });

  it('should handle insert events (diff = 1)', () => {
    const insertEvent: StreamEvent = TestData.streamEvent(
      TestData.basicRow('123', 'test', 42.5)
    );

    cache.applyStreamEvent(insertEvent);

    expect(cache.size()).toBe(1);
    const expectedRow = TestData.basicRow('123', 'test', 42.5);
    expect(cache.getRow('123')).toEqual(expectedRow);
    expect(cache.getAllRows()).toEqual([expectedRow]);
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
    expect(cache.getAllRows()).toEqual([]);
  });

  it('should handle multiple rows', () => {
    const events: StreamEvent[] = [
      { row: { id: '1', name: 'first', value: 10 }, diff: 1 },
      { row: { id: '2', name: 'second', value: 20 }, diff: 1 },
      { row: { id: '3', name: 'third', value: 30 }, diff: 1 },
    ];

    events.forEach(event => cache.applyStreamEvent(event));

    expect(cache.size()).toBe(3);
    expect(cache.getAllRows()).toHaveLength(3);
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
    expect(cache.getAllRows()).toEqual([]);
  });

  describe('subscriber functionality', () => {
    it('should notify subscribers on insert', () => {
      const mockSubscriber: CacheSubscriber = {
        onUpdate: vi.fn()
      };

      const unsubscribe = cache.subscribe(mockSubscriber);

      const insertEvent: StreamEvent = {
        row: { id: '123', name: 'test', value: 42.5 },
        diff: 1,
      };

      cache.applyStreamEvent(insertEvent);

      expect(mockSubscriber.onUpdate).toHaveBeenCalledWith({
        type: 'insert',
        row: { id: '123', name: 'test', value: 42.5 },
        previousRow: undefined
      });

      unsubscribe();
    });

    it('should notify subscribers on update', () => {
      const mockSubscriber: CacheSubscriber = {
        onUpdate: vi.fn()
      };

      // Insert initial row
      cache.applyStreamEvent({
        row: { id: '123', name: 'test', value: 42.5 },
        diff: 1,
      });

      // Subscribe after initial insert
      const unsubscribe = cache.subscribe(mockSubscriber);

      // Update the row
      const updateEvent: StreamEvent = {
        row: { id: '123', name: 'updated', value: 99.9 },
        diff: 1,
      };

      cache.applyStreamEvent(updateEvent);

      expect(mockSubscriber.onUpdate).toHaveBeenCalledWith({
        type: 'update',
        row: { id: '123', name: 'updated', value: 99.9 },
        previousRow: { id: '123', name: 'test', value: 42.5 }
      });

      unsubscribe();
    });

    it('should notify subscribers on delete', () => {
      const mockSubscriber: CacheSubscriber = {
        onUpdate: vi.fn()
      };

      // Insert initial row
      cache.applyStreamEvent({
        row: { id: '123', name: 'test', value: 42.5 },
        diff: 1,
      });

      const unsubscribe = cache.subscribe(mockSubscriber);

      // Delete the row
      const deleteEvent: StreamEvent = {
        row: { id: '123', name: 'test', value: 42.5 },
        diff: -1,
      };

      cache.applyStreamEvent(deleteEvent);

      expect(mockSubscriber.onUpdate).toHaveBeenCalledWith({
        type: 'delete',
        row: { id: '123', name: 'test', value: 42.5 },
        previousRow: { id: '123', name: 'test', value: 42.5 }
      });

      unsubscribe();
    });

    it('should support multiple subscribers', () => {
      const subscriber1: CacheSubscriber = { onUpdate: vi.fn() };
      const subscriber2: CacheSubscriber = { onUpdate: vi.fn() };

      const unsubscribe1 = cache.subscribe(subscriber1);
      const unsubscribe2 = cache.subscribe(subscriber2);

      cache.applyStreamEvent({
        row: { id: '123', name: 'test', value: 42.5 },
        diff: 1,
      });

      expect(subscriber1.onUpdate).toHaveBeenCalledTimes(1);
      expect(subscriber2.onUpdate).toHaveBeenCalledTimes(1);

      unsubscribe1();
      unsubscribe2();
    });

    it('should properly unsubscribe', () => {
      const mockSubscriber: CacheSubscriber = {
        onUpdate: vi.fn()
      };

      const unsubscribe = cache.subscribe(mockSubscriber);
      
      // First event should trigger callback
      cache.applyStreamEvent({
        row: { id: '123', name: 'test', value: 42.5 },
        diff: 1,
      });
      
      expect(mockSubscriber.onUpdate).toHaveBeenCalledTimes(1);
      
      // Unsubscribe
      unsubscribe();
      
      // Second event should NOT trigger callback
      cache.applyStreamEvent({
        row: { id: '456', name: 'test2', value: 100 },
        diff: 1,
      });
      
      expect(mockSubscriber.onUpdate).toHaveBeenCalledTimes(1); // Still only 1
    });

    it('should emit current state to new subscribers', async () => {
      // Pre-populate cache
      cache.applyStreamEvent({ row: { id: '1', name: 'first', value: 10 }, diff: 1 });
      cache.applyStreamEvent({ row: { id: '2', name: 'second', value: 20 }, diff: 1 });

      const receivedEvents: RowUpdateEvent[] = [];
      const mockSubscriber: CacheSubscriber = {
        onUpdate: (event) => receivedEvents.push(event)
      };

      const unsubscribe = cache.subscribe(mockSubscriber);

      // Wait for current state to be emitted
      await TEST_DELAYS.SHORT();

      // Should have received current state as insert events
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0]).toEqual({
        type: 'insert',
        row: { id: '1', name: 'first', value: 10 },
        previousRow: undefined
      });
      expect(receivedEvents[1]).toEqual({
        type: 'insert',
        row: { id: '2', name: 'second', value: 20 },
        previousRow: undefined
      });

      unsubscribe();
    });
  });
});