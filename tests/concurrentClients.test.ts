import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MaterializeStreamer } from '../src/materialize.js';
import { GraphQLSubscriptionHandler } from '../src/graphqlSubscriptionHandler.js';
import type { RowUpdateEvent } from '../shared/databaseStreamer.js';
import { RowUpdateType } from '../shared/databaseStreamer.js';
import type { LoadedSchema } from '../shared/schema.js';
import type { DatabaseConfig } from '../src/config.js';
import { TEST_DELAYS, createTestSubscriber, TestData, simulateMaterializeEvent } from './test-utils.js';
import { Client } from 'pg';

// Mock pg and pg-copy-streams modules
vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined), 
    query: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('pg-copy-streams', () => ({
  from: vi.fn(),
  to: vi.fn().mockReturnValue({
    on: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  }),
}));

describe('Concurrent Client Support', () => {
  let streamer: MaterializeStreamer;
  const viewName = 'test_view';
  
  const testConfig: DatabaseConfig = {
    host: 'localhost',
    port: 6875,
    user: 'materialize',
    password: 'password',
    database: 'materialize',
  };

  const testSchema: LoadedSchema = {
    typeDefs: '',
    fields: [
      { name: 'id', type: 'ID', nullable: false, isPrimaryKey: true },
      { name: 'name', type: 'String', nullable: true, isPrimaryKey: false },
      { name: 'value', type: 'Int', nullable: true, isPrimaryKey: false },
    ],
    primaryKeyField: 'id',
    viewName: 'test_view',
    databaseViewName: 'test_view'
  };

  beforeEach(() => {
    streamer = new MaterializeStreamer(testConfig, testSchema);
  });

  afterEach(() => {
    // Cleanup
  });

  describe('Multiple concurrent clients', () => {
    it('should handle multiple clients receiving same events', async () => {
      // Create multiple subscription handlers
      const handler1 = createTestSubscriber(viewName, 'client-1');
      const handler2 = createTestSubscriber(viewName, 'client-2');
      const handler3 = createTestSubscriber(viewName, 'client-3');

      // Subscribe all handlers to the streamer
      const unsub1 = streamer.subscribe(handler1);
      const unsub2 = streamer.subscribe(handler2);
      const unsub3 = streamer.subscribe(handler3);

      const iterator1 = handler1.createAsyncIterator();
      const iterator2 = handler2.createAsyncIterator();
      const iterator3 = handler3.createAsyncIterator();

      // Emit an event from the streamer
      setTimeout(() => {
        simulateMaterializeEvent(streamer, TestData.rowUpdateEvent({ id: '1', name: 'test', value: 100 }));
      }, 20);

      // All clients should receive the same event
      const result1 = await iterator1.next();
      const result2 = await iterator2.next();
      const result3 = await iterator3.next();

      expect(result1.value).toEqual({ [viewName]: { id: '1', name: 'test', value: 100 } });
      expect(result2.value).toEqual(result1.value);
      expect(result3.value).toEqual(result1.value);

      // Cleanup
      handler1.close();
      handler2.close();
      handler3.close();
      unsub1();
      unsub2();
      unsub3();
    });

    it('should handle clients connecting and disconnecting at different times', async () => {
      const events: any[] = [];
      
      // First client connects
      const handler1 = createTestSubscriber(viewName, 'client-1');
      const unsub1 = streamer.subscribe(handler1);
      const iter1 = handler1.createAsyncIterator();

      // Emit first event
      setTimeout(() => {
        simulateMaterializeEvent(streamer, TestData.rowUpdateEvent({ id: '1', name: 'first' }));
      }, 20);

      const event1 = await iter1.next();
      expect(event1.value).toEqual({ [viewName]: { id: '1', name: 'first' } });

      // Second client connects
      const handler2 = createTestSubscriber(viewName, 'client-2');
      const unsub2 = streamer.subscribe(handler2);
      const iter2 = handler2.createAsyncIterator();

      // Second client will receive the replayed first event from ReplaySubject
      const event2_1 = await iter2.next();
      expect(event2_1.value).toEqual({ [viewName]: { id: '1', name: 'first' } });

      // Then emit second event (both clients should get it)
      setTimeout(() => {
        simulateMaterializeEvent(streamer, TestData.rowUpdateEvent({ id: '2', name: 'second' }));
      }, 20);

      const event1_2 = await iter1.next();
      const event2_2 = await iter2.next();
      
      expect(event1_2.value).toEqual({ [viewName]: { id: '2', name: 'second' } });
      expect(event2_2.value).toEqual({ [viewName]: { id: '2', name: 'second' } });

      // First client disconnects
      handler1.close();
      unsub1();

      // Emit third event (only client 2 should get it)
      setTimeout(() => {
        simulateMaterializeEvent(streamer, TestData.rowUpdateEvent({ id: '3', name: 'third' }));
      }, 20);

      const event2_3 = await iter2.next();
      expect(event2_3.value).toEqual({ [viewName]: { id: '3', name: 'third' } });

      // Cleanup
      handler2.close();
      unsub2();
    });

    it('should track subscriber count correctly', () => {
      expect(streamer.subscriberCount).toBe(0);

      const handler1 = createTestSubscriber(viewName);
      const unsub1 = streamer.subscribe(handler1);
      expect(streamer.subscriberCount).toBe(1);

      const handler2 = createTestSubscriber(viewName);
      const unsub2 = streamer.subscribe(handler2);
      expect(streamer.subscriberCount).toBe(2);

      unsub1();
      expect(streamer.subscriberCount).toBe(1);

      unsub2();
      expect(streamer.subscriberCount).toBe(0);

      handler1.close();
      handler2.close();
    });
  });
});