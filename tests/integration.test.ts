import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { MaterializeStreamer } from '../backend/src/materialize.js';
import { GraphQLServer } from '../backend/src/yoga.js';
import { loadSchema } from '../backend/src/config.js';
import { pubsub } from '../backend/src/pubsub.js';
import { EVENTS } from '../shared/events.js';
import type { DatabaseConfig, StreamEvent } from '../shared/types.js';

// Mock pg client for integration tests
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  on: vi.fn(),
};

// Create a mock constructor that returns our mock client
const MockClient = vi.fn().mockImplementation(() => mockClient);

vi.mock('pg', () => ({
  Client: MockClient,
}));

vi.mock('pg-query-stream', () => ({
  default: vi.fn(),
}));

describe('Integration Tests', () => {
  const testConfig: DatabaseConfig = {
    host: 'localhost',
    port: 6875,
    user: 'materialize',
    password: 'password',
    database: 'materialize',
    viewName: 'live_pnl',
  };

  it('should integrate MaterializeStreamer with ViewCache', async () => {
    const schema = loadSchema('live_pnl');
    const streamer = new MaterializeStreamer(testConfig, schema.primaryKeyField);
    
    // Mock successful connection
    await streamer.connect();
    expect(MockClient).toHaveBeenCalled();
    expect(mockClient.connect).toHaveBeenCalled();

    // Simulate stream events
    const testEvents: StreamEvent[] = [
      {
        row: { instrument_id: '1', symbol: 'AAPL', net_position: 100 },
        diff: 1,
      },
      {
        row: { instrument_id: '2', symbol: 'GOOGL', net_position: 50 },
        diff: 1,
      },
    ];

    // Apply events to cache
    testEvents.forEach(event => {
      streamer.cache.applyStreamEvent(event);
    });

    // Verify cache state
    expect(streamer.cache.size()).toBe(2);
    expect(streamer.cache.getRow('1')).toEqual({ 
      instrument_id: '1', 
      symbol: 'AAPL', 
      net_position: 100 
    });

    await streamer.disconnect();
  });

  it('should integrate pub/sub with stream events', async () => {
    const receivedEvents: StreamEvent[] = [];
    
    // Subscribe to stream events
    pubsub.subscribeToStream('live_pnl', (event: StreamEvent) => {
      receivedEvents.push(event);
    });

    // Publish test events
    const testEvent: StreamEvent = {
      row: { instrument_id: '123', symbol: 'TEST', net_position: 42 },
      diff: 1,
    };

    pubsub.publishStreamEvent('live_pnl', testEvent);

    // Verify event was received
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]).toEqual(testEvent);
  });

  it('should handle startup sequence correctly', async () => {
    const events: string[] = [];
    
    // Track startup events
    pubsub.subscribe(EVENTS.STREAM_CONNECTED, () => events.push('connected'));
    pubsub.subscribe(EVENTS.SCHEMA_LOADED, () => events.push('schema'));
    pubsub.subscribe(EVENTS.STREAM_UPDATE_RECEIVED, () => events.push('update'));

    // Simulate startup sequence
    pubsub.publish(EVENTS.SCHEMA_LOADED, { viewName: 'live_pnl' });
    pubsub.publish(EVENTS.STREAM_CONNECTED, { viewName: 'live_pnl' });
    pubsub.publish(EVENTS.STREAM_UPDATE_RECEIVED, { viewName: 'live_pnl' });

    expect(events).toEqual(['schema', 'connected', 'update']);
  });

  it('should handle error scenarios gracefully', async () => {
    const schema = loadSchema('live_pnl');
    const streamer = new MaterializeStreamer(testConfig, schema.primaryKeyField);
    
    // Mock connection failure
    mockClient.connect.mockReset();
    mockClient.connect.mockRejectedValueOnce(new Error('Connection failed'));

    await expect(streamer.connect()).rejects.toThrow('Database connection failed');
    expect(streamer.connected).toBe(false);
  });
});