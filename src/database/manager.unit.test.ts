import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DatabaseSubscriberManager } from './manager';
import { DatabaseSubscriber } from './subscriber';
import { MaterializeProtocolHandler } from './materialize';
import type { GraphQLSchema, SourceSchema } from '../core/schema';
import type { DatabaseConfig } from '../core/config';

// Mock the logger
vi.mock('../core/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn()
    }))
  }
}));

// Mock the DatabaseSubscriber and MaterializeProtocolHandler
vi.mock('./subscriber');
vi.mock('./materialize');

describe('DatabaseSubscriberManager', () => {
  let manager: DatabaseSubscriberManager;
  let mockSchema: GraphQLSchema;
  let mockDbConfig: DatabaseConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Set up the mock implementation for MaterializeProtocolHandler
    vi.mocked(MaterializeProtocolHandler).mockImplementation(() => ({
      createSubscribeQuery: vi.fn().mockReturnValue('SUBSCRIBE TO test'),
      parseLine: vi.fn()
    } as any));
    
    // Set up the mock implementation for DatabaseSubscriber
    vi.mocked(DatabaseSubscriber).mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getSnapshot: vi.fn().mockResolvedValue([]),
      getUpdates: vi.fn().mockReturnValue({
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockResolvedValue({ done: true })
        })
      })
    } as any));
    
    // Create mock schema with two sources
    const source1: SourceSchema = {
      typeDefs: 'type Source1 { id: Int! }',
      fields: [{ name: 'id', type: 'Int!', nullable: false, isPrimaryKey: true }],
      primaryKeyField: 'id',
      sourceName: 'source1'
    };

    const source2: SourceSchema = {
      typeDefs: 'type Source2 { id: Int! }',
      fields: [{ name: 'id', type: 'Int!', nullable: false, isPrimaryKey: true }],
      primaryKeyField: 'id',
      sourceName: 'source2'
    };

    mockSchema = {
      sources: new Map([
        ['source1', source1],
        ['source2', source2]
      ]),
      typeDefs: 'type Query { _empty: String }'
    };

    mockDbConfig = {
      host: 'localhost',
      port: 6875,
      user: 'test',
      password: 'test',
      database: 'test'
    };

    manager = new DatabaseSubscriberManager(mockDbConfig, mockSchema);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('start', () => {
    it('should create and start a subscriber for each source', async () => {
      await manager.start();

      // Should create two protocol handlers and subscribers
      expect(MaterializeProtocolHandler).toHaveBeenCalledTimes(2);
      expect(DatabaseSubscriber).toHaveBeenCalledTimes(2);
      
      // Check first protocol handler and subscriber
      expect(MaterializeProtocolHandler).toHaveBeenNthCalledWith(
        1,
        mockSchema.sources.get('source1')
      );
      expect(DatabaseSubscriber).toHaveBeenNthCalledWith(
        1,
        mockDbConfig,
        mockSchema.sources.get('source1'),
        expect.any(Object) // protocol handler instance
      );
      
      // Check second protocol handler and subscriber
      expect(MaterializeProtocolHandler).toHaveBeenNthCalledWith(
        2,
        mockSchema.sources.get('source2')
      );
      expect(DatabaseSubscriber).toHaveBeenNthCalledWith(
        2,
        mockDbConfig,
        mockSchema.sources.get('source2'),
        expect.any(Object) // protocol handler instance
      );

      // Verify start was called on each subscriber
      const mockInstances = (DatabaseSubscriber as any).mock.results;
      expect(mockInstances[0].value.start).toHaveBeenCalled();
      expect(mockInstances[1].value.start).toHaveBeenCalled();
    });

    it('should handle start failures gracefully', async () => {
      const error = new Error('Connection failed');
      const failingSubscriber = {
        start: vi.fn().mockRejectedValue(error),
        stop: vi.fn()
      };
      
      (DatabaseSubscriber as any).mockImplementationOnce(() => failingSubscriber);

      await expect(manager.start()).rejects.toThrow('Connection failed');
    });
  });

  describe('stop', () => {
    it('should stop all subscribers', async () => {
      await manager.start();
      await manager.stop();

      const mockInstances = (DatabaseSubscriber as any).mock.results;
      expect(mockInstances[0].value.stop).toHaveBeenCalled();
      expect(mockInstances[1].value.stop).toHaveBeenCalled();
    });

    it('should handle stop when not started', async () => {
      // Should not throw when stopping without starting
      await expect(manager.stop()).resolves.not.toThrow();
    });
  });

  describe('getSubscriber', () => {
    it('should return the correct subscriber for a source', async () => {
      await manager.start();
      
      const subscriber1 = manager.getSubscriber('source1');
      const subscriber2 = manager.getSubscriber('source2');
      
      expect(subscriber1).toBeDefined();
      expect(subscriber2).toBeDefined();
      expect(subscriber1).not.toBe(subscriber2);
    });

    it('should return undefined for non-existent source', async () => {
      await manager.start();
      
      const subscriber = manager.getSubscriber('nonexistent');
      expect(subscriber).toBeUndefined();
    });

    it('should return undefined when not started', () => {
      const subscriber = manager.getSubscriber('source1');
      expect(subscriber).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('should handle empty schema', async () => {
      const emptySchema: GraphQLSchema = {
        sources: new Map(),
        typeDefs: 'type Query { _empty: String }'
      };
      
      const emptyManager = new DatabaseSubscriberManager(mockDbConfig, emptySchema);
      await emptyManager.start();
      
      expect(MaterializeProtocolHandler).not.toHaveBeenCalled();
      expect(DatabaseSubscriber).not.toHaveBeenCalled();
    });

    it('should handle concurrent start calls', async () => {
      // Call start multiple times concurrently
      const startPromises = [
        manager.start(),
        manager.start(),
        manager.start()
      ];
      
      await Promise.all(startPromises);
      
      // Currently the manager doesn't prevent duplicate starts
      // Each call to start() creates new subscribers
      expect(MaterializeProtocolHandler).toHaveBeenCalledTimes(6); // 3 calls * 2 sources
      expect(DatabaseSubscriber).toHaveBeenCalledTimes(6); // 3 calls * 2 sources
    });
  });
});