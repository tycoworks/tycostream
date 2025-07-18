import { describe, it, expect, vi } from 'vitest';
import { DatabaseSubscriber } from '../src/database/subscriber.js';
import { MaterializeProtocolHandler } from '../src/database/materialize.js';
import type { GraphQLSchema, SourceSchema } from '../src/core/schema.js';
import type { RowUpdateEvent } from '../src/database/types.js';
import { RowUpdateType } from '../src/database/types.js';
import type { DatabaseConfig } from '../src/core/config.js';
import { Client } from 'pg';
import { simulateMaterializeEvent } from './test-utils.js';

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
  const testSourceSchema: SourceSchema = {
    typeDefs: `type live_pnl {
  instrument_id: ID!
  symbol: String
  net_position: Int
  latest_price: Float
  market_value: Float
  avg_cost_basis: Float
  theoretical_pnl: Float
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
    sourceName: 'live_pnl'
  };
  
  const testSchema: GraphQLSchema = {
    sources: new Map([['live_pnl', testSourceSchema]]),
    typeDefs: `type live_pnl {
  instrument_id: ID!
  symbol: String
  net_position: Int
  latest_price: Float
  market_value: Float
  avg_cost_basis: Float
  theoretical_pnl: Float
}

# Minimal Query type required by GraphQL spec
type Query {
  _empty: String
}

type Subscription {
  live_pnl: live_pnl!
}`
  };

  it('should integrate components together', async () => {
    // Create components following new architecture
    const protocol = new MaterializeProtocolHandler(testSourceSchema);
    const streamer = new DatabaseSubscriber(testConfig, testSourceSchema, protocol);
    
    // Test connection
    await streamer.start();
    expect(vi.mocked(Client)).toHaveBeenCalled();

    // Test we can get rows
    expect(streamer.getAllRows()).toEqual([]);
    expect(streamer.streaming).toBe(false);

    await streamer.stop();
  });

  it('should handle subscription and emit events', async () => {
    const protocol = new MaterializeProtocolHandler(testSourceSchema);
    const streamer = new DatabaseSubscriber(testConfig, testSourceSchema, protocol);
    await streamer.start(); // Need to start first
    
    const receivedEvents: RowUpdateEvent[] = [];
    
    // Create async iterator consumer
    const consumeEvents = async () => {
      for await (const event of streamer.getUpdates()) {
        receivedEvents.push(event);
        // Break after first event for test
        if (receivedEvents.length === 1) break;
      }
    };
    
    // Start consuming in background
    const consumerPromise = consumeEvents();

    // Wait a bit for initialization
    await new Promise(resolve => setTimeout(resolve, 50));

    // Manually emit an event (simulating what would happen in processRow)
    simulateMaterializeEvent(streamer, {
      type: RowUpdateType.Insert,
      row: { instrument_id: '123', symbol: 'TEST', net_position: 42 }
    });

    // Wait for consumer to receive event
    await consumerPromise;

    // Verify event was received
    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0]?.type).toEqual(RowUpdateType.Insert);
    expect(receivedEvents[0]?.row).toEqual({ instrument_id: '123', symbol: 'TEST', net_position: 42 });

    await streamer.stop();
  });

  it('should handle connection error scenarios gracefully', async () => {
    const protocol = new MaterializeProtocolHandler(testSourceSchema);
    const streamer = new DatabaseSubscriber(testConfig, testSourceSchema, protocol);
    
    // Mock connection failure
    mockClientInstance.connect.mockReset();
    mockClientInstance.connect.mockRejectedValueOnce(new Error('Connection failed'));

    await expect(streamer.start()).rejects.toThrow('Database connection failed');
  });

  it('should test DatabaseSubscriber construction', () => {
    // Test that DatabaseSubscriber can be constructed with proper schema
    expect(() => {
      const protocol = new MaterializeProtocolHandler(testSourceSchema);
      new DatabaseSubscriber(testConfig, testSourceSchema, protocol);
    }).not.toThrow();
  });
});