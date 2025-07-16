import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import { MaterializeStreamer } from '../src/materialize.js';
import { GraphQLServer } from '../src/graphqlServer.js';
import { EVENTS } from '../shared/events.js';
import type { LoadedSchema } from '../shared/schema.js';
import type { RowUpdateEvent } from '../shared/databaseStreamer.js';
import { RowUpdateType } from '../shared/databaseStreamer.js';
import type { DatabaseConfig } from '../src/config.js';
import { Client } from 'pg';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { createTestCache, simulateMaterializeEvent } from './test-utils.js';

// Create a mock client instance that can be accessed in tests
const mockClientInstance = {
  connect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined), 
  query: vi.fn().mockImplementation((stream) => {
    // Return the stream for COPY queries
    if (stream && stream.on) {
      return stream;
    }
    return Promise.resolve({ rows: [] });
  }),
  on: vi.fn(),
};

// Mock pg and pg-copy-streams modules
vi.mock('pg', () => ({
  Client: vi.fn().mockImplementation(() => mockClientInstance),
}));

vi.mock('pg-copy-streams', () => ({
  from: vi.fn(),
  to: vi.fn().mockReturnValue({
    on: vi.fn((event, handler) => {
      // Immediately call 'end' handler for tests
      if (event === 'end') {
        setImmediate(() => handler());
      }
    }),
    write: vi.fn(),
    end: vi.fn(),
    destroy: vi.fn(),
  }),
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
    const streamer = new MaterializeStreamer(testConfig, testSchema);
    
    // Test connection
    await streamer.start();
    expect(vi.mocked(Client)).toHaveBeenCalled();

    // Test we can get rows
    expect(streamer.getAllRows()).toEqual([]);
    expect(streamer.streaming).toBe(false);

    await streamer.stop();
  });

  it('should handle subscription and emit events', async () => {
    const streamer = new MaterializeStreamer(testConfig, testSchema);
    await streamer.start(); // Need to start first
    
    const receivedEvents: RowUpdateEvent[] = [];
    
    // Subscribe to events
    const unsubscribe = streamer.subscribe({
      onUpdate: (event) => receivedEvents.push(event)
    });

    // Wait a bit for initialization
    await new Promise(resolve => setTimeout(resolve, 50));

    // Manually emit an event (simulating what would happen in processRow)
    simulateMaterializeEvent(streamer, {
      type: RowUpdateType.Insert,
      row: { instrument_id: '123', symbol: 'TEST', net_position: 42 }
    });

    // Wait for event processing
    await new Promise(resolve => setTimeout(resolve, 10));

    // Verify event was received
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.type).toEqual(RowUpdateType.Insert);
    expect(receivedEvents[0]?.row).toEqual({ instrument_id: '123', symbol: 'TEST', net_position: 42 });

    unsubscribe();
    await streamer.stop();
  });

  it('should handle connection error scenarios gracefully', async () => {
    const streamer = new MaterializeStreamer(testConfig, testSchema);
    
    // Mock connection failure
    mockClientInstance.connect.mockReset();
    mockClientInstance.connect.mockRejectedValueOnce(new Error('Connection failed'));

    await expect(streamer.start()).rejects.toThrow('Database connection failed');
  });

  it('should test MaterializeStreamer construction', () => {
    // Test that MaterializeStreamer can be constructed with proper schema
    expect(() => {
      new MaterializeStreamer(testConfig, testSchema);
    }).not.toThrow();
  });
});