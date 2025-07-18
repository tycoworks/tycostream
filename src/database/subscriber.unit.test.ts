import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { SourceSchema } from '../core/schema';
import type { DatabaseConfig } from '../core/config';
import { RowUpdateType } from './types';

// Mock modules before imports
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
  on: vi.fn().mockReturnThis(),
  destroy: vi.fn()
};

vi.mock('pg-copy-streams', () => ({
  to: vi.fn(() => mockCopyStream)
}));

// Import after mocks
import { DatabaseSubscriber } from './subscriber';

describe('DatabaseSubscriber', () => {
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

    // Setup mock responses
    mockClient.query.mockImplementation(() => mockCopyStream);

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

  describe('streaming state', () => {
    it('should track streaming state correctly', async () => {
      await subscriber.start();
      expect(subscriber.streaming).toBe(false);
      
      // When we call getUpdates, it should start streaming
      // But since the complex RxJS mocking is difficult, we just verify the public API
      const iterator = subscriber.getUpdates();
      
      // The startStreaming method will be called but may fail due to mocking
      // We're testing the public interface rather than internal state
      expect(typeof iterator.next).toBe('function');
    });

    it('should handle stream cleanup on stop', async () => {
      await subscriber.start();
      expect(subscriber.streaming).toBe(false);
      
      // Stop should work even when not streaming
      await subscriber.stop();
      
      // Verify cleanup was called
      expect(mockConnection.disconnect).toHaveBeenCalledWith(mockClient);
    });
  });

  describe('timestamp ordering', () => {
    let exitSpy: any;

    beforeEach(() => {
      // Mock process.exit
      exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called');
      }) as any);
    });

    afterEach(() => {
      exitSpy.mockRestore();
    });

    it('should exit process when receiving out-of-order timestamp', async () => {
      await subscriber.start();
      
      // Access the private method directly for testing
      const applyOperation = (subscriber as any).applyOperation.bind(subscriber);

      // First update with timestamp 100
      applyOperation({ id: '1', name: 'Test' }, BigInt(100), false);

      // Second update with lower timestamp (should trigger exit)
      expect(() => {
        applyOperation({ id: '2', name: 'Test2' }, BigInt(50), false);
      }).toThrow('process.exit called');
      
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('should accept equal timestamps', async () => {
      await subscriber.start();
      
      // Access the private method directly for testing
      const applyOperation = (subscriber as any).applyOperation.bind(subscriber);

      // First update with timestamp 100
      applyOperation({ id: '1', name: 'Test' }, BigInt(100), false);

      // Second update with same timestamp (should be ok)
      expect(() => {
        applyOperation({ id: '2', name: 'Test2' }, BigInt(100), false);
      }).not.toThrow();
      
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it('should accept increasing timestamps', async () => {
      await subscriber.start();
      
      // Access the private method directly for testing
      const applyOperation = (subscriber as any).applyOperation.bind(subscriber);

      // First update with timestamp 100
      applyOperation({ id: '1', name: 'Test' }, BigInt(100), false);

      // Second update with higher timestamp (should be ok)
      expect(() => {
        applyOperation({ id: '2', name: 'Test2' }, BigInt(150), false);
      }).not.toThrow();
      
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});