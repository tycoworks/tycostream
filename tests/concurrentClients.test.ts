import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ViewCache } from '../shared/viewCache.js';
import { ClientStreamHandler } from '../src/clientStreamHandler.js';
import type { StreamEvent } from '../shared/viewCache.js';
import { TEST_DELAYS, createTestCache, createTestSubscriber } from './test-utils.js';

describe('Concurrent Client Support', () => {
  let cache: ViewCache;
  const viewName = 'test_view';
  const primaryKeyField = 'id';

  beforeEach(() => {
    cache = createTestCache(primaryKeyField, viewName);
  });

  afterEach(() => {
    // Cleanup any running handlers
  });

  describe('Multiple concurrent clients', () => {
    it('should handle multiple clients connecting simultaneously', async () => {
      // Pre-populate cache with some data
      cache.applyStreamEvent({ row: { id: '1', name: 'existing', value: 100 }, diff: 1, timestamp: BigInt(1000) });
      cache.applyStreamEvent({ row: { id: '2', name: 'existing2', value: 200 }, diff: 1, timestamp: BigInt(2000) });

      // Create multiple clients
      const client1 = createTestSubscriber(cache, 'client-1');
      const client2 = createTestSubscriber(cache, 'client-2');
      const client3 = createTestSubscriber(cache, 'client-3');

      const iterator1 = client1.createAsyncIterator();
      const iterator2 = client2.createAsyncIterator();
      const iterator3 = client3.createAsyncIterator();

      // Each client should receive the same initial state
      const client1Results: any[] = [];
      const client2Results: any[] = [];
      const client3Results: any[] = [];

      // Get initial state for all clients (2 rows each)
      for (let i = 0; i < 2; i++) {
        client1Results.push((await iterator1.next()).value);
        client2Results.push((await iterator2.next()).value);
        client3Results.push((await iterator3.next()).value);
      }

      // All clients should have received the same initial state
      expect(client1Results).toEqual(client2Results);
      expect(client2Results).toEqual(client3Results);
      expect(client1Results).toHaveLength(2);

      // Cleanup
      client1.close();
      client2.close();
      client3.close();
    });

    it('should isolate each client stream independently', async () => {
      const client1 = createTestSubscriber(cache, 'client-1');
      const client2 = createTestSubscriber(cache, 'client-2');

      const iterator1 = client1.createAsyncIterator();
      const iterator2 = client2.createAsyncIterator();

      // Send updates after both clients connected
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '1', name: 'test1', value: 10 }, diff: 1, timestamp: BigInt(3000) });
        cache.applyStreamEvent({ row: { id: '2', name: 'test2', value: 20 }, diff: 1, timestamp: BigInt(4000) });
      }, 20);

      // Both clients should receive both updates
      const result1_1 = await iterator1.next();
      const result1_2 = await iterator1.next();

      const result2_1 = await iterator2.next();
      const result2_2 = await iterator2.next();

      expect(result1_1.value).toEqual(result2_1.value);
      expect(result1_2.value).toEqual(result2_2.value);

      client1.close();
      client2.close();
    });

    it('should handle client disconnection without affecting others', async () => {
      const client1 = createTestSubscriber(cache, 'client-1');
      const client2 = createTestSubscriber(cache, 'client-2');

      const iterator1 = client1.createAsyncIterator();
      const iterator2 = client2.createAsyncIterator();

      // Send initial update
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '1', name: 'test', value: 10 }, diff: 1, timestamp: BigInt(1000) });
      }, 20);

      // Both clients receive first update
      const result1_1 = await iterator1.next();
      const result2_1 = await iterator2.next();

      expect(result1_1.value).toEqual({ [viewName]: { id: '1', name: 'test', value: 10 } });
      expect(result2_1.value).toEqual({ [viewName]: { id: '1', name: 'test', value: 10 } });

      // Disconnect client1
      client1.close();
      expect(client1.active).toBe(false);
      expect(client2.active).toBe(true);

      // Send another update - only client2 should receive it
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '2', name: 'test2', value: 20 }, diff: 1, timestamp: BigInt(1000) });
      }, 20);

      const result2_2 = await iterator2.next();
      expect(result2_2.value).toEqual({ [viewName]: { id: '2', name: 'test2', value: 20 } });

      client2.close();
    });
  });

  describe('Order preservation', () => {
    it('should preserve update order across multiple clients', async () => {
      const client1 = createTestSubscriber(cache, 'client-1');
      const client2 = createTestSubscriber(cache, 'client-2');

      const iterator1 = client1.createAsyncIterator();
      const iterator2 = client2.createAsyncIterator();

      // Send multiple updates in specific order
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '1', name: 'first', value: 1 }, diff: 1, timestamp: BigInt(1000) });
        cache.applyStreamEvent({ row: { id: '2', name: 'second', value: 2 }, diff: 1, timestamp: BigInt(1000) });
        cache.applyStreamEvent({ row: { id: '3', name: 'third', value: 3 }, diff: 1, timestamp: BigInt(1000) });
        cache.applyStreamEvent({ row: { id: '1', name: 'first-updated', value: 11 }, diff: 1, timestamp: BigInt(1000) }); // Update
      }, 20);

      const client1Results: any[] = [];
      const client2Results: any[] = [];

      // Collect results from both clients
      try {
        for (let i = 0; i < 4; i++) {
          const [result1, result2] = await Promise.all([
            iterator1.next(),
            iterator2.next()
          ]);
          client1Results.push(result1.value);
          client2Results.push(result2.value);
        }
      } finally {
        client1.close();
        client2.close();
      }

      // Both clients should receive identical ordered results
      expect(client1Results).toEqual(client2Results);
      
      // Verify specific order
      expect(client1Results[0]).toEqual({ [viewName]: { id: '1', name: 'first', value: 1 } });
      expect(client1Results[1]).toEqual({ [viewName]: { id: '2', name: 'second', value: 2 } });
      expect(client1Results[2]).toEqual({ [viewName]: { id: '3', name: 'third', value: 3 } });
      expect(client1Results[3]).toEqual({ [viewName]: { id: '1', name: 'first-updated', value: 11 } });
    });

    it('should handle updates during initial state delivery', async () => {
      // Pre-populate cache with multiple rows to simulate larger initial state
      for (let i = 1; i <= 5; i++) {
        cache.applyStreamEvent({ 
          row: { id: `${i}`, name: `initial-${i}`, value: i * 10 }, 
          diff: 1,
          timestamp: BigInt(i * 1000)
        });
      }

      const client = createTestSubscriber(cache, 'test-client');
      const iterator = client.createAsyncIterator();
      const results: any[] = [];

      // Start consuming initial state, but add new data while consuming
      setTimeout(() => {
        // This should queue up and come after initial state
        cache.applyStreamEvent({ row: { id: '6', name: 'live-update', value: 60 }, diff: 1, timestamp: BigInt(1000) });
      }, 10);

      // Collect all results (5 initial + 1 live update)
      for (let i = 0; i < 6; i++) {
        results.push((await iterator.next()).value);
      }

      // First 5 should be initial state in order
      for (let i = 0; i < 5; i++) {
        expect(results[i]).toEqual({ 
          [viewName]: { id: `${i + 1}`, name: `initial-${i + 1}`, value: (i + 1) * 10 } 
        });
      }

      // Last one should be the live update
      expect(results[5]).toEqual({ [viewName]: { id: '6', name: 'live-update', value: 60 } });

      client.close();
    });
  });

  describe('Edge cases', () => {
    it('should handle early client connection (before any data)', async () => {
      // Client connects to empty cache
      const client = createTestSubscriber(cache, 'early-client');
      const iterator = client.createAsyncIterator();

      // No initial state, so first result should be live data
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '1', name: 'first-data', value: 100 }, diff: 1, timestamp: BigInt(1000) });
      }, 20);

      const result = await iterator.next();
      expect(result.value).toEqual({ [viewName]: { id: '1', name: 'first-data', value: 100 } });

      client.close();
    });

    it('should handle mid-stream client connection', async () => {
      // Add some initial data
      cache.applyStreamEvent({ row: { id: '1', name: 'existing', value: 10 }, diff: 1, timestamp: BigInt(1000) });
      
      // Start sending live updates
      const liveUpdates = setInterval(() => {
        cache.applyStreamEvent({ 
          row: { id: Date.now().toString(), name: 'live', value: Math.random() }, 
          diff: 1,
          timestamp: BigInt(Date.now())
        });
      }, 50);

      // Wait a bit for some live updates
      await TEST_DELAYS.LONG();

      // Now connect a new client mid-stream
      const midStreamClient = createTestSubscriber(cache, 'mid-stream-client');
      const iterator = midStreamClient.createAsyncIterator();

      // Should get current state (which includes the ongoing updates)
      const result = await iterator.next();
      expect(result.value[viewName]).toHaveProperty('id');
      expect(result.value[viewName]).toHaveProperty('name');
      expect(result.value[viewName]).toHaveProperty('value');

      clearInterval(liveUpdates);
      midStreamClient.close();
    });

    it('should handle rapid successive client connections', async () => {
      // Pre-populate with data
      cache.applyStreamEvent({ row: { id: '1', name: 'test', value: 100 }, diff: 1, timestamp: BigInt(1000) });

      const clients: ClientStreamHandler[] = [];
      const iterators: AsyncIterator<any>[] = [];

      // Create 10 clients rapidly
      for (let i = 0; i < 10; i++) {
        const client = createTestSubscriber(cache, `rapid-client-${i}`);
        clients.push(client);
        iterators.push(client.createAsyncIterator());
      }

      // All clients should receive the same initial data
      const results = await Promise.all(
        iterators.map(async (iterator) => (await iterator.next()).value)
      );

      // All results should be identical
      const expected = { [viewName]: { id: '1', name: 'test', value: 100 } };
      results.forEach(result => {
        expect(result).toEqual(expected);
      });

      // Cleanup
      clients.forEach(client => client.close());
    });

    it('should handle cache updates with no active clients', async () => {
      // Send updates to cache with no clients
      cache.applyStreamEvent({ row: { id: '1', name: 'lonely', value: 42 }, diff: 1, timestamp: BigInt(1000) });
      cache.applyStreamEvent({ row: { id: '2', name: 'lonely2', value: 84 }, diff: 1, timestamp: BigInt(1000) });

      // Connect client after updates
      const client = createTestSubscriber(cache, 'late-client');
      const iterator = client.createAsyncIterator();

      // Should receive current state (both rows)
      const result1 = await iterator.next();
      const result2 = await iterator.next();

      expect(result1.value).toEqual({ [viewName]: { id: '1', name: 'lonely', value: 42 } });
      expect(result2.value).toEqual({ [viewName]: { id: '2', name: 'lonely2', value: 84 } });

      client.close();
    });
  });

  describe('Resource management', () => {
    it('should properly clean up resources on client close', async () => {
      const client = createTestSubscriber(cache, 'cleanup-test');
      const iterator = client.createAsyncIterator();

      // Start iteration
      setTimeout(() => {
        cache.applyStreamEvent({ row: { id: '1', name: 'test', value: 10 }, diff: 1, timestamp: BigInt(1000) });
      }, 20);

      await iterator.next(); // Get first result

      // Check client is active and subscribed
      expect(client.active).toBe(true);
      expect(cache.listenerCount('update')).toBe(1);

      // Close client
      client.close();

      // Should clean up
      expect(client.active).toBe(false);
      expect(cache.listenerCount('update')).toBe(0);
    });

    it('should handle multiple subscribe/unsubscribe cycles', async () => {
      // Test that subscribers are properly cleaned up
      const clients: ClientStreamHandler[] = [];
      const iterators: AsyncIterator<any>[] = [];

      // Create multiple clients and consume from iterators (this subscribes them)
      for (let i = 0; i < 3; i++) {
        const client = createTestSubscriber(cache, `cycle-client-${i}`);
        clients.push(client);
        const iterator = client.createAsyncIterator();
        iterators.push(iterator);
        // Trigger subscription by starting iteration
        iterator.next();
      }

      // Wait a bit for subscriptions to be established
      await TEST_DELAYS.SHORT();

      // Should have some subscribers
      expect(cache.listenerCount('update')).toBeGreaterThan(0);

      // Close all
      clients.forEach(client => client.close());

      // All should be unsubscribed
      await TEST_DELAYS.SHORT();
      expect(cache.listenerCount('update')).toBe(0);
    });
  });
});