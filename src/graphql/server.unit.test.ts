import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GraphQLServer } from './server';
import type { GraphQLSchema } from '../core/schema';
import type { DatabaseConfig } from '../core/config';

// Mock dependencies
vi.mock('../core/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    })),
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn()
  },
  truncateForLog: vi.fn((obj) => JSON.stringify(obj))
}));

vi.mock('../core/config', () => ({
  isGraphQLUIEnabled: vi.fn().mockReturnValue(false)
}));

vi.mock('../database/manager');
vi.mock('./setup');
vi.mock('@graphql-tools/schema');

describe('GraphQLServer', () => {
  let server: GraphQLServer;
  let mockSchema: GraphQLSchema;
  let mockDbConfig: DatabaseConfig;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSchema = {
      sources: new Map([
        ['test_source', {
          typeDefs: 'type Test { id: ID! }',
          fields: [{ name: 'id', type: 'ID!', nullable: false, isPrimaryKey: true }],
          primaryKeyField: 'id',
          sourceName: 'test_source'
        }]
      ]),
      typeDefs: 'type Query { _empty: String } type Subscription { test_source: Test }'
    };

    mockDbConfig = {
      host: 'localhost',
      port: 6875,
      user: 'test',
      password: 'test',
      database: 'test'
    };

    server = new GraphQLServer(mockDbConfig, mockSchema, 4001);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should create server with default port', () => {
      const defaultServer = new GraphQLServer(mockDbConfig, mockSchema);
      expect(defaultServer).toBeDefined();
    });

    it('should create server with custom port', () => {
      expect(server).toBeDefined();
    });
  });

  describe('start', () => {
    it('should start all components successfully', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');
      const { createGraphQLServers } = await import('./setup');
      const { makeExecutableSchema } = await import('@graphql-tools/schema');

      const mockSubscriberManager = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getSubscriber: vi.fn()
      };

      const mockServers = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);
      vi.mocked(createGraphQLServers).mockReturnValue(mockServers);
      vi.mocked(makeExecutableSchema).mockReturnValue({} as any);

      await server.start();

      expect(DatabaseSubscriberManager).toHaveBeenCalledWith(mockDbConfig, mockSchema);
      expect(mockSubscriberManager.start).toHaveBeenCalled();
      expect(createGraphQLServers).toHaveBeenCalled();
      expect(mockServers.start).toHaveBeenCalledWith(4001);
    });

    it('should handle startup errors', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');

      const mockSubscriberManager = {
        start: vi.fn().mockRejectedValue(new Error('DB connection failed'))
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);

      await expect(server.start()).rejects.toThrow('GraphQL server startup failed: DB connection failed');
    });
  });

  describe('stop', () => {
    it('should stop all components', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');
      const { createGraphQLServers } = await import('./setup');
      const { makeExecutableSchema } = await import('@graphql-tools/schema');

      const mockSubscriberManager = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getSubscriber: vi.fn()
      };

      const mockServers = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);
      vi.mocked(createGraphQLServers).mockReturnValue(mockServers);
      vi.mocked(makeExecutableSchema).mockReturnValue({} as any);

      // Start first
      await server.start();

      // Then stop
      await server.stop();

      expect(mockServers.stop).toHaveBeenCalled();
      expect(mockSubscriberManager.stop).toHaveBeenCalled();
    });

    it('should handle stop when not started', async () => {
      // Should not throw
      await expect(server.stop()).resolves.not.toThrow();
    });
  });

  describe('buildGraphQLSchema', () => {
    it('should create schema with subscription resolvers', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');
      const { createGraphQLServers } = await import('./setup');
      const { makeExecutableSchema } = await import('@graphql-tools/schema');

      const mockSubscriberManager = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getSubscriber: vi.fn()
      };

      const mockServers = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);
      vi.mocked(createGraphQLServers).mockReturnValue(mockServers);
      
      let capturedResolvers: any;
      vi.mocked(makeExecutableSchema).mockImplementation((config) => {
        capturedResolvers = config.resolvers;
        return {} as any;
      });

      await server.start();

      expect(makeExecutableSchema).toHaveBeenCalledWith({
        typeDefs: mockSchema.typeDefs,
        resolvers: expect.any(Object)
      });

      // Check resolver structure
      expect(capturedResolvers).toHaveProperty('Query._empty');
      expect(capturedResolvers).toHaveProperty('Subscription.test_source');
      expect(capturedResolvers.Subscription.test_source).toHaveProperty('subscribe');
      expect(capturedResolvers.Subscription.test_source).toHaveProperty('resolve');
    });
  });

  describe('subscription resolver', () => {
    it('should handle subscription stream', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');
      const { createGraphQLServers } = await import('./setup');
      const { makeExecutableSchema } = await import('@graphql-tools/schema');

      const mockUpdates = [
        { type: 'insert', row: { id: '1', name: 'test' } },
        { type: 'update', row: { id: '1', name: 'updated' } }
      ];

      const mockSubscriber = {
        getUpdates: vi.fn().mockImplementation(async function* () {
          for (const update of mockUpdates) {
            yield update;
          }
        })
      };

      const mockSubscriberManager = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getSubscriber: vi.fn().mockReturnValue(mockSubscriber)
      };

      const mockServers = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);
      vi.mocked(createGraphQLServers).mockReturnValue(mockServers);
      
      let capturedResolvers: any;
      vi.mocked(makeExecutableSchema).mockImplementation((config) => {
        capturedResolvers = config.resolvers;
        return {} as any;
      });

      await server.start();

      // Test the subscription resolver
      const subscribeFunc = capturedResolvers.Subscription.test_source.subscribe;
      const context = { subscriberManager: mockSubscriberManager };
      
      const updates = [];
      for await (const update of subscribeFunc(null, null, context)) {
        updates.push(update);
      }

      expect(updates).toHaveLength(2);
      expect(updates[0]).toEqual({ test_source: { id: '1', name: 'test' } });
      expect(updates[1]).toEqual({ test_source: { id: '1', name: 'updated' } });

      // Test the resolve function
      const resolveFunc = capturedResolvers.Subscription.test_source.resolve;
      const resolved = resolveFunc({ test_source: { id: '1' } });
      expect(resolved).toEqual({ id: '1' });
    });

    it('should handle missing subscriber', async () => {
      const { DatabaseSubscriberManager } = await import('../database/manager');
      const { createGraphQLServers } = await import('./setup');
      const { makeExecutableSchema } = await import('@graphql-tools/schema');

      const mockSubscriberManager = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        getSubscriber: vi.fn().mockReturnValue(undefined) // No subscriber found
      };

      const mockServers = {
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined)
      };

      vi.mocked(DatabaseSubscriberManager).mockImplementation(() => mockSubscriberManager as any);
      vi.mocked(createGraphQLServers).mockReturnValue(mockServers);
      
      let capturedResolvers: any;
      vi.mocked(makeExecutableSchema).mockImplementation((config) => {
        capturedResolvers = config.resolvers;
        return {} as any;
      });

      await server.start();

      // Test error handling
      const subscribeFunc = capturedResolvers.Subscription.test_source.subscribe;
      const context = { subscriberManager: mockSubscriberManager };
      
      const iterator = subscribeFunc(null, null, context);
      await expect(iterator.next()).rejects.toThrow('No streamer found for source: test_source');
    });
  });
});