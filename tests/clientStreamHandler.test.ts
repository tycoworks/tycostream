import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ClientStreamHandler } from '../src/clientStreamHandler.js';
import { ViewCache } from '../shared/viewCache.js';
import type { StreamEvent } from '../shared/viewCache.js';
import { TEST_DELAYS, createTestCache } from './test-utils.js';

describe('ClientStreamHandler', () => {
  let cache: ViewCache;
  let handler: ClientStreamHandler;
  const viewName = 'test_view';
  const primaryKeyField = 'id';

  beforeEach(() => {
    cache = createTestCache(primaryKeyField, viewName);
    handler = new ClientStreamHandler(viewName, cache);
  });

  afterEach(() => {
    handler.close();
  });

  it('should create handler with generated client ID', () => {
    expect(handler.id).toMatch(/^client-[A-Za-z0-9_-]{10}$/);
    expect(handler.active).toBe(true);
  });

  it('should create handler with custom client ID', () => {
    const customHandler = new ClientStreamHandler(viewName, cache, 'custom-id');
    expect(customHandler.id).toBe('custom-id');
    customHandler.close();
  });

  it('should yield initial state when cache has data', async () => {
    // Populate cache with test data
    cache.applyStreamEvent({
      row: { id: '1', name: 'first', value: 10 },
      diff: 1,
      timestamp: BigInt(1000),
    });
    cache.applyStreamEvent({
      row: { id: '2', name: 'second', value: 20 },
      diff: 1,
      timestamp: BigInt(2000),
    });

    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Get initial state (should be 2 items)
    const result1 = await iterator.next();
    expect(result1.done).toBe(false);
    results.push(result1.value);

    const result2 = await iterator.next();
    expect(result2.done).toBe(false);
    results.push(result2.value);

    // Verify initial state was delivered
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ [viewName]: { id: '1', name: 'first', value: 10 } });
    expect(results[1]).toEqual({ [viewName]: { id: '2', name: 'second', value: 20 } });

    handler.close();
  });

  it('should handle empty initial state', async () => {
    const iterator = handler.createAsyncIterator();
    
    // Should not yield anything for empty cache
    // Add data to trigger live updates
    setTimeout(() => {
      cache.applyStreamEvent({
        row: { id: '1', name: 'test', value: 42 },
        diff: 1,
        timestamp: BigInt(1000),
      });
    }, 20);

    const result = await iterator.next();
    expect(result.done).toBe(false);
    expect(result.value).toEqual({ [viewName]: { id: '1', name: 'test', value: 42 } });

    handler.close();
  });

  it('should receive live updates after initial state', async () => {
    // Start with some initial data
    cache.applyStreamEvent({
      row: { id: '1', name: 'initial', value: 10 },
      diff: 1,
      timestamp: BigInt(1000),
    });

    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Get initial state
    const initialResult = await iterator.next();
    expect(initialResult.done).toBe(false);
    results.push(initialResult.value);

    // Add new data (should come as live update)
    setTimeout(() => {
      cache.applyStreamEvent({
        row: { id: '2', name: 'live', value: 20 },
        diff: 1,
        timestamp: BigInt(2000),
      });
    }, 20);

    const liveResult = await iterator.next();
    expect(liveResult.done).toBe(false);
    results.push(liveResult.value);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ [viewName]: { id: '1', name: 'initial', value: 10 } });
    expect(results[1]).toEqual({ [viewName]: { id: '2', name: 'live', value: 20 } });

    handler.close();
  });

  it('should handle updates (not just inserts)', async () => {
    // Start with initial data
    cache.applyStreamEvent({
      row: { id: '1', name: 'original', value: 10 },
      diff: 1,
      timestamp: BigInt(1000),
    });

    const iterator = handler.createAsyncIterator();

    // Get initial state
    const initialResult = await iterator.next();
    expect(initialResult.value).toEqual({ [viewName]: { id: '1', name: 'original', value: 10 } });

    // Update the same row
    setTimeout(() => {
      cache.applyStreamEvent({
        row: { id: '1', name: 'updated', value: 99 },
        diff: 1,
        timestamp: BigInt(2000),
      });
    }, 20);

    const updateResult = await iterator.next();
    expect(updateResult.value).toEqual({ [viewName]: { id: '1', name: 'updated', value: 99 } });

    handler.close();
  });

  it('should preserve update order', async () => {
    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Send multiple updates in sequence
    setTimeout(() => {
      cache.applyStreamEvent({ row: { id: '1', name: 'first', value: 1 }, diff: 1, timestamp: BigInt(1000) });
      cache.applyStreamEvent({ row: { id: '2', name: 'second', value: 2 }, diff: 1, timestamp: BigInt(2000) });
      cache.applyStreamEvent({ row: { id: '3', name: 'third', value: 3 }, diff: 1, timestamp: BigInt(3000) });
    }, 20);

    // Collect results
    for (let i = 0; i < 3; i++) {
      const result = await iterator.next();
      results.push(result.value);
    }

    // Verify order is preserved
    expect(results[0]).toEqual({ [viewName]: { id: '1', name: 'first', value: 1 } });
    expect(results[1]).toEqual({ [viewName]: { id: '2', name: 'second', value: 2 } });
    expect(results[2]).toEqual({ [viewName]: { id: '3', name: 'third', value: 3 } });

    handler.close();
  });

  it('should handle close properly', async () => {
    const iterator = handler.createAsyncIterator();

    // Close the handler
    handler.close();

    expect(handler.active).toBe(false);

    // Should not receive any more updates
    cache.applyStreamEvent({
      row: { id: '1', name: 'test', value: 42 },
      diff: 1,
      timestamp: BigInt(1000),
    });

    // Give it a moment to potentially process (it shouldn't)
    await TEST_DELAYS.MEDIUM();
    
    // Handler should still be inactive
    expect(handler.active).toBe(false);
  });

  it('should skip delete events for now', async () => {
    // Start with data
    cache.applyStreamEvent({
      row: { id: '1', name: 'test', value: 10 },
      diff: 1,
      timestamp: BigInt(1000),
    });

    const iterator = handler.createAsyncIterator();

    // Get initial state
    const initialResult = await iterator.next();
    expect(initialResult.value).toEqual({ [viewName]: { id: '1', name: 'test', value: 10 } });

    // Delete the row (should be skipped)
    setTimeout(() => {
      cache.applyStreamEvent({
        row: { id: '1', name: 'test', value: 10 },
        diff: -1,
        timestamp: BigInt(1500),
      });
      
      // Add new row (should be received)
      cache.applyStreamEvent({
        row: { id: '2', name: 'new', value: 20 },
        diff: 1,
        timestamp: BigInt(2000),
      });
    }, 20);

    // Should only get the new insert, not the delete
    const nextResult = await iterator.next();
    expect(nextResult.value).toEqual({ [viewName]: { id: '2', name: 'new', value: 20 } });

    handler.close();
  });

  it('should throw error if iterator created on inactive handler', async () => {
    handler.close();
    expect(handler.active).toBe(false);

    const iterator = handler.createAsyncIterator();
    await expect(iterator.next()).rejects.toThrow('ClientStreamHandler is not active');
  });
});