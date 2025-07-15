import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { MaterializeStreamer } from '../src/materialize.js';
import { ViewCache } from '../shared/viewCache.js';
import { GraphQLServer } from '../src/yoga.js';
import { pubsub } from '../src/pubsub.js';
import { EVENTS } from '../shared/events.js';
import type { LoadedSchema } from '../shared/schema.js';
import type { StreamEvent } from '../shared/viewCache.js';
import type { DatabaseConfig } from '../src/config.js';
import { Client } from 'pg';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createTestCache } from './test-utils.js';

// Create a mock client instance that can be accessed in tests
const mockClientInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined), 
  query: vi.fn(),
  on: vi.fn(),
};

// Mock pg and pg-copy-streams modules
vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => mockClientInstance),
}));

vi.mock('pg-copy-streams', () => ({
  from: vi.fn(),
  to: vi.fn(),
}));

describe('Integration Tests', () => {
  const testConfig: DatabaseConfig = {
    host: 'localhost',
    port: 6875,
    user: 'materialize',
    password: 'password',
    database: 'materialize',
  };

  // Use a hardcoded test schema (matches production YAML structure)
  const testSchema: LoadedSchema = {
    typeDefs: `type live_pnl {
  instrument_id: ID!
  symbol: String
  net_position: Int
  latest_price: Float
  market_value: Float
  avg_cost_basis: Float
  theoretical_pnl: Float
}

type Query {
  # Current snapshot of live_pnl data
  live_pnl: [live_pnl!]!
}

type Subscription {
  live_pnl: live_pnl!
}`,
    fields: [
      { name: 'instrument_id', type: 'ID', nullable: false, isPrimaryKey: true },
      { name: 'symbol', type: 'String', nullable: true, isPrimaryKey: false },
      { name: 'net_position', type: 'Int', nullable: true, isPrimaryKey: false },
      { name: 'latest_price', type: 'Float', nullable: true, isPrimaryKey: false },
      { name: 'market_value', type: 'Float', nullable: true, isPrimaryKey: false },
      { name: 'avg_cost_basis', type: 'Float', nullable: true, isPrimaryKey: false },
      { name: 'theoretical_pnl', type: 'Float', nullable: true, isPrimaryKey: false },
    ],
    primaryKeyField: 'instrument_id',
    viewName: 'live_pnl',
    databaseViewName: 'live_pnl'
  };

  it('should integrate components together', async () => {
    // Create components following new architecture
    const cache = createTestCache(testSchema.primaryKeyField, testSchema.databaseViewName);
    const streamer = new MaterializeStreamer(testConfig, testSchema.fields, cache);
    
    // Test connection
    await streamer.connect();
    expect(vi.mocked(Client)).toHaveBeenCalled();

    // Simulate stream events directly on cache (since we're testing integration)
    const testEvents: StreamEvent[] = [
      {
        row: { instrument_id: '1', symbol: 'AAPL', net_position: 100 },
        diff: 1,
        timestamp: BigInt(1000),
      },
      {
        row: { instrument_id: '2', symbol: 'GOOGL', net_position: 50 },
        diff: 1,
        timestamp: BigInt(2000),
      },
    ];

    // Apply events to cache
    testEvents.forEach(event => {
      cache.applyStreamEvent(event);
    });

    // Verify cache state
    expect(cache.size()).toBe(2);
    expect(cache.getRow('1')).toEqual({ 
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
      timestamp: BigInt(3000),
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

  it('should handle connection error scenarios gracefully', async () => {
    const cache = createTestCache(testSchema.primaryKeyField, testSchema.viewName);
    const streamer = new MaterializeStreamer(testConfig, testSchema.fields, cache);
    
    // Mock connection failure
    mockClientInstance.connect.mockReset();
    mockClientInstance.connect.mockRejectedValueOnce(new Error('Connection failed'));

    await expect(streamer.connect()).rejects.toThrow('Database connection failed');
  });

  it('should test MaterializeStreamer construction', () => {
    // Test that MaterializeStreamer can be constructed with proper schema fields
    // The internal parser and connection logic will be tested through integration
    const cache = createTestCache(testSchema.primaryKeyField, testSchema.viewName);
    
    expect(() => {
      new MaterializeStreamer(testConfig, testSchema.fields, cache);
    }).not.toThrow();
  });
});