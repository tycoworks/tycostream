import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { GraphQLSubscriptionHandler } from '../src/graphqlSubscriptionHandler.js';
import type { RowUpdateEvent } from '../shared/databaseStreamer.js';
import { RowUpdateType } from '../shared/databaseStreamer.js';
import { TEST_DELAYS, createTestSubscriber, TestData } from './test-utils.js';

describe('GraphQLSubscriptionHandler', () => {
  let handler: GraphQLSubscriptionHandler;
  const viewName = 'test_view';

  beforeEach(() => {
    handler = createTestSubscriber(viewName);
  });

  afterEach(() => {
    handler.close();
  });

  it('should create handler with generated client ID', () => {
    expect(handler.id).toMatch(/^client-[A-Za-z0-9_-]{10}$/);
    expect(handler.active).toBe(true);
  });

  it('should create handler with custom client ID', () => {
    const customHandler = createTestSubscriber(viewName, 'custom-id');
    expect(customHandler.id).toBe('custom-id');
    customHandler.close();
  });

  it('should yield events when onUpdate is called', async () => {
    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Send some events
    setTimeout(() => {
      handler.onUpdate(TestData.rowUpdateEvent({ id: '1', name: 'first', value: 10 }));
      handler.onUpdate(TestData.rowUpdateEvent({ id: '2', name: 'second', value: 20 }));
    }, 20);

    // Get the events
    const result1 = await iterator.next();
    expect(result1.done).toBe(false);
    expect(result1.value).toEqual({ [viewName]: { id: '1', name: 'first', value: 10 } });

    const result2 = await iterator.next();
    expect(result2.done).toBe(false);
    expect(result2.value).toEqual({ [viewName]: { id: '2', name: 'second', value: 20 } });

    handler.close();
  });

  it('should handle updates', async () => {
    const iterator = handler.createAsyncIterator();

    // Send an update event
    setTimeout(() => {
      handler.onUpdate(TestData.rowUpdateEvent({ id: '1', name: 'updated', value: 99 }, RowUpdateType.Update));
    }, 20);

    const updateResult = await iterator.next();
    expect(updateResult.value).toEqual({ [viewName]: { id: '1', name: 'updated', value: 99 } });

    handler.close();
  });

  it('should handle deletes by passing through row data', async () => {
    const iterator = handler.createAsyncIterator();

    // Send a delete event
    setTimeout(() => {
      handler.onUpdate(TestData.rowUpdateEvent({ id: '1' }, RowUpdateType.Delete));
    }, 20);

    const deleteResult = await iterator.next();
    expect(deleteResult.value).toEqual({ [viewName]: { id: '1' } });

    handler.close();
  });

  it('should preserve update order', async () => {
    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Send multiple updates in sequence
    setTimeout(() => {
      handler.onUpdate(TestData.rowUpdateEvent({ id: '1', name: 'first', value: 1 }));
      handler.onUpdate(TestData.rowUpdateEvent({ id: '2', name: 'second', value: 2 }));
      handler.onUpdate(TestData.rowUpdateEvent({ id: '3', name: 'third', value: 3 }));
    }, 20);

    // Collect all results
    for (let i = 0; i < 3; i++) {
      const result = await iterator.next();
      expect(result.done).toBe(false);
      results.push(result.value);
    }

    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ [viewName]: { id: '1', name: 'first', value: 1 } });
    expect(results[1]).toEqual({ [viewName]: { id: '2', name: 'second', value: 2 } });
    expect(results[2]).toEqual({ [viewName]: { id: '3', name: 'third', value: 3 } });

    handler.close();
  });

  it('should close gracefully', async () => {
    const iterator = handler.createAsyncIterator();
    
    // Send an event
    setTimeout(() => {
      handler.onUpdate(TestData.rowUpdateEvent({ id: '1', name: 'test' }));
    }, 20);

    // Get first event
    await iterator.next();

    // Close handler
    handler.close();
    expect(handler.active).toBe(false);

    // Should not process new events after close
    handler.onUpdate(TestData.rowUpdateEvent({ id: '2', name: 'ignored' }));
    
    // Iterator should be done
    const afterClose = await iterator.next();
    expect(afterClose.done).toBe(true);
  });

  it('should handle concurrent event processing', async () => {
    const iterator = handler.createAsyncIterator();
    const results: any[] = [];

    // Send many events rapidly
    const eventCount = 10;
    setTimeout(() => {
      for (let i = 0; i < eventCount; i++) {
        handler.onUpdate(TestData.rowUpdateEvent({ id: String(i), value: i }));
      }
    }, 20);

    // Collect all events
    for (let i = 0; i < eventCount; i++) {
      const result = await iterator.next();
      results.push(result.value);
    }

    expect(results).toHaveLength(eventCount);
    // Verify order is preserved
    for (let i = 0; i < eventCount; i++) {
      expect(results[i]).toEqual({ [viewName]: { id: String(i), value: i } });
    }

    handler.close();
  });

  it('should handle createAsyncIterator on inactive handler', async () => {
    handler.close();
    
    // The async generator throws when we try to iterate
    const iterator = handler.createAsyncIterator();
    await expect(iterator.next()).rejects.toThrow('GraphQL subscription handler is not active');
  });
});