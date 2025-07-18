import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseSubscriber } from './subscriber';
import type { SourceSchema } from '../core/schema';
import type { DatabaseConfig } from '../core/config';
import { RowUpdateType } from './types';

// Mock modules
vi.mock('../core/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }))
  },
  truncateForLog: vi.fn((obj) => JSON.stringify(obj))
}));

// Mock database connection
const mockClient = {
  query: vi.fn(),
  on: vi.fn()
};

const mockConnection = {
  connect: vi.fn().mockResolvedValue(mockClient),
  disconnect: vi.fn().mockResolvedValue(undefined)
};

vi.mock('./connection', () => ({
  DatabaseConnection: vi.fn(() => mockConnection)
}));

// Mock pg-copy-streams
const mockCopyStream = {
  on: vi.fn(),
  destroy: vi.fn()
};

vi.mock('pg-copy-streams', () => ({
  to: vi.fn(() => mockCopyStream)
}));

describe('DatabaseSubscriber - Basic Tests', () => {
  let subscriber: DatabaseSubscriber;
  let mockSchema: SourceSchema;
  let mockConfig: DatabaseConfig;
  let mockProtocol: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockSchema = {
      typeDefs: 'type Test { id: ID! name: String! }',
      fields: [
        { name: 'id', type: 'ID!', nullable: false, isPrimaryKey: true },
        { name: 'name', type: 'String!', nullable: false, isPrimaryKey: false }
      ],
      primaryKeyField: 'id',
      sourceName: 'test_view'
    };

    mockConfig = {
      host: 'localhost',
      port: 6875,
      user: 'test',
      password: 'test',
      database: 'test'
    };

    mockProtocol = {
      createSubscribeQuery: vi.fn().mockReturnValue('SUBSCRIBE TO test_view'),
      parseLine: vi.fn()
    };

    subscriber = new DatabaseSubscriber(mockConfig, mockSchema, mockProtocol);
  });

  describe('basic functionality', () => {
    it('should start and stop correctly', async () => {
      await subscriber.start();
      expect(mockConnection.connect).toHaveBeenCalledWith(mockConfig);

      await subscriber.stop();
      expect(mockConnection.disconnect).toHaveBeenCalledWith(mockClient);
    });

    it('should get rows from cache', () => {
      expect(subscriber.getAllRows()).toEqual([]);
    });

    it('should get specific row by primary key', () => {
      expect(subscriber.getRow('123')).toBeUndefined();
    });

    it('should track subscriber count', () => {
      expect(subscriber.subscriberCount).toBe(0);
    });

    it('should report streaming status', () => {
      expect(subscriber.streaming).toBe(false);
    });
  });

  describe('error handling', () => {
    it('should handle getUpdates when client not started', async () => {
      const iterator = subscriber.getUpdates();
      await expect(iterator.next()).rejects.toThrow('Database streamer must be started before subscribing');
    });

    it('should handle stop when not started', async () => {
      // Should not throw
      await expect(subscriber.stop()).resolves.not.toThrow();
    });

    it('should handle multiple stops', async () => {
      await subscriber.start();
      await subscriber.stop();
      await expect(subscriber.stop()).resolves.not.toThrow();
    });
  });

});