import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGraphQLServers } from './setup';
import type { GraphQLSchema } from 'graphql';
import type { DatabaseSubscriberManager } from '../database/manager';

// Mock dependencies
vi.mock('../core/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn()
    }))
  }
}));

vi.mock('graphql-yoga', () => ({
  createYoga: vi.fn(() => ({
    graphqlEndpoint: '/graphql',
    handle: vi.fn()
  }))
}));

vi.mock('http', () => ({
  createServer: vi.fn(() => ({
    listen: vi.fn((port, callback) => callback()),
    close: vi.fn((callback) => callback()),
    on: vi.fn()
  }))
}));

vi.mock('ws', () => ({
  WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn()
  }))
}));

vi.mock('graphql-ws/lib/use/ws', () => ({
  useServer: vi.fn()
}));

describe('GraphQL Setup', () => {
  let mockSchema: GraphQLSchema;
  let mockSubscriberManager: DatabaseSubscriberManager;

  beforeEach(() => {
    vi.clearAllMocks();

    mockSchema = {
      // Minimal GraphQL schema mock
      __schema: {}
    } as any;

    mockSubscriberManager = {
      start: vi.fn(),
      stop: vi.fn(),
      getSubscriber: vi.fn(),
      getAllSubscribers: vi.fn()
    } as any;
  });

  describe('createGraphQLServers', () => {
    it('should create servers with GraphiQL enabled', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));
      const { createServer } = vi.mocked(await import('http'));
      const { WebSocketServer } = vi.mocked(await import('ws'));
      const { useServer } = vi.mocked(await import('graphql-ws/lib/use/ws'));

      const servers = createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: true
      });

      expect(createYoga).toHaveBeenCalledWith({
        schema: mockSchema,
        graphiql: {
          subscriptionsProtocol: 'WS'
        },
        context: expect.any(Function),
        maskedErrors: false,
        plugins: expect.any(Array)
      });

      expect(createServer).toHaveBeenCalled();
      expect(WebSocketServer).toHaveBeenCalled();
      expect(useServer).toHaveBeenCalled();
      expect(servers).toHaveProperty('start');
      expect(servers).toHaveProperty('stop');
    });

    it('should create servers with GraphiQL disabled', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      expect(createYoga).toHaveBeenCalledWith({
        schema: mockSchema,
        graphiql: false,
        context: expect.any(Function),
        maskedErrors: false,
        plugins: expect.any(Array)
      });
    });

    it('should start HTTP server on specified port', async () => {
      const { createServer } = vi.mocked(await import('http'));
      const mockHttpServer = {
        listen: vi.fn((port, callback) => {
          expect(port).toBe(4000);
          callback();
        }),
        close: vi.fn(),
        on: vi.fn()
      };
      vi.mocked(createServer).mockReturnValue(mockHttpServer as any);

      const servers = createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      await servers.start(4000);
      expect(mockHttpServer.listen).toHaveBeenCalled();
    });

    it('should stop servers properly', async () => {
      const { createServer } = vi.mocked(await import('http'));
      const { WebSocketServer } = vi.mocked(await import('ws'));

      const mockHttpServer = {
        listen: vi.fn((port, callback) => callback()),
        close: vi.fn((callback) => callback()),
        on: vi.fn()
      };

      const mockWsServer = {
        on: vi.fn(),
        close: vi.fn()
      };

      vi.mocked(createServer).mockReturnValue(mockHttpServer as any);
      vi.mocked(WebSocketServer).mockImplementation(() => mockWsServer as any);

      const servers = createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      await servers.start(4000);
      await servers.stop();

      expect(mockWsServer.close).toHaveBeenCalled();
      expect(mockHttpServer.close).toHaveBeenCalled();
    });
  });

  describe('Yoga server configuration', () => {
    it('should provide subscriber manager in context', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));

      let capturedContext: any;
      vi.mocked(createYoga).mockImplementation((config) => {
        capturedContext = config.context;
        return {
          graphqlEndpoint: '/graphql',
          handle: vi.fn()
        } as any;
      });

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      // Test context function
      const context = capturedContext();
      expect(context).toEqual({ subscriberManager: mockSubscriberManager });
    });

    it('should configure logging plugins', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));

      let capturedPlugins: any[];
      vi.mocked(createYoga).mockImplementation((config) => {
        capturedPlugins = config.plugins;
        return {
          graphqlEndpoint: '/graphql',
          handle: vi.fn()
        } as any;
      });

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      // Should have at least one plugin
      expect(capturedPlugins).toBeDefined();
      expect(capturedPlugins.length).toBeGreaterThan(0);

      // Test plugin has onRequest hook
      const plugin = capturedPlugins[0];
      expect(plugin).toHaveProperty('onRequest');
      expect(plugin).toHaveProperty('onExecute');
      expect(plugin).toHaveProperty('onResultProcess');
    });
  });

  describe('Plugin hooks', () => {
    it('should log HTTP requests via onRequest hook', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));
      const { logger } = vi.mocked(await import('../core/logger'));

      let capturedPlugins: any[];
      vi.mocked(createYoga).mockImplementation((config) => {
        capturedPlugins = config.plugins;
        return {
          graphqlEndpoint: '/graphql',
          handle: vi.fn()
        } as any;
      });

      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn()
      };
      vi.mocked(logger.child).mockReturnValue(mockLogger as any);

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      // Test onRequest hook
      const plugin = capturedPlugins[0];
      const mockRequest = {
        method: 'POST',
        headers: new Map([['user-agent', 'test-agent/1.0']])
      };
      const mockUrl = { pathname: '/graphql' };
      
      plugin.onRequest({ request: mockRequest, url: mockUrl });
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'GraphQL HTTP Request',
        expect.objectContaining({
          method: 'POST',
          url: '/graphql',
          userAgent: 'test-agent/1.0'
        })
      );
    });

    it('should log operation execution and results', async () => {
      const { createYoga } = vi.mocked(await import('graphql-yoga'));
      const { logger } = vi.mocked(await import('../core/logger'));

      let capturedPlugins: any[];
      vi.mocked(createYoga).mockImplementation((config) => {
        capturedPlugins = config.plugins;
        return {
          graphqlEndpoint: '/graphql',
          handle: vi.fn()
        } as any;
      });

      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn()
      };
      vi.mocked(logger.child).mockReturnValue(mockLogger as any);

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      // Test onExecute hook
      const plugin = capturedPlugins[0];
      const mockArgs = {
        operationName: 'TestQuery',
        document: {
          definitions: [{
            kind: 'OperationDefinition',
            operation: 'query'
          }]
        },
        variableValues: { id: '123' }
      };
      
      plugin.onExecute({ args: mockArgs });
      
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operationName: 'TestQuery',
          operationType: 'query',
          hasVariables: true
        }),
        'GraphQL Operation'
      );

      // Test onResultProcess hook
      const mockResult = {
        data: {
          test: { id: '1', name: 'Test' }
        }
      };
      const mockRequest = { operationName: 'TestQuery' };
      
      plugin.onResultProcess({ result: mockResult, request: mockRequest });
      
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'GraphQL Result',
        expect.objectContaining({
          operationType: 'TestQuery',
          dataKeys: ['test'],
          resultSample: expect.stringContaining('"test":{"id":"1"')
        })
      );
    });
  });

  describe('WebSocket server configuration', () => {
    it('should configure WebSocket server correctly', async () => {
      const { WebSocketServer } = vi.mocked(await import('ws'));
      const { useServer } = vi.mocked(await import('graphql-ws/lib/use/ws'));

      let wsServerConfig: any;
      vi.mocked(WebSocketServer).mockImplementation((config) => {
        wsServerConfig = config;
        return {
          on: vi.fn(),
          close: vi.fn()
        } as any;
      });

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      expect(wsServerConfig).toHaveProperty('server');
      expect(wsServerConfig).toHaveProperty('path', '/graphql');
      
      expect(useServer).toHaveBeenCalledWith(
        {
          schema: mockSchema,
          context: expect.any(Function),
          onConnect: expect.any(Function),
          onDisconnect: expect.any(Function),
          onSubscribe: expect.any(Function),
          onError: expect.any(Function)
        },
        expect.any(Object) // WebSocket server instance
      );
    });

    it('should handle WebSocket connection lifecycle', async () => {
      const { useServer } = vi.mocked(await import('graphql-ws/lib/use/ws'));
      const { logger } = vi.mocked(await import('../core/logger'));

      let capturedHandlers: any;
      vi.mocked(useServer).mockImplementation((handlers) => {
        capturedHandlers = handlers;
        return {} as any;
      });

      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        error: vi.fn()
      };
      vi.mocked(logger.child).mockReturnValue(mockLogger as any);

      createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      // Test handlers exist
      expect(capturedHandlers).toHaveProperty('onConnect');
      expect(capturedHandlers).toHaveProperty('onDisconnect');
      expect(capturedHandlers).toHaveProperty('onSubscribe');
      expect(capturedHandlers).toHaveProperty('onError');

      // Test onConnect
      capturedHandlers.onConnect({ connectionParams: { auth: 'token' } });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'GraphQL WebSocket client connected',
        { connectionParams: { auth: 'token' } }
      );

      // Test onDisconnect
      capturedHandlers.onDisconnect({});
      expect(mockLogger.debug).toHaveBeenCalledWith('GraphQL WebSocket client disconnected');

      // Test onSubscribe
      capturedHandlers.onSubscribe({}, {
        payload: {
          operationName: 'TestSubscription',
          variables: { id: '123' }
        }
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.objectContaining({
          operationName: 'TestSubscription',
          operationType: 'subscription',
          hasVariables: true
        }),
        'GraphQL Operation'
      );

      // Test error handler doesn't throw
      expect(() => capturedHandlers.onError({}, { payload: 'error' }, [new Error('Test error')])).not.toThrow();
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'GraphQL WebSocket error',
        expect.objectContaining({
          message: 'error',
          errorCount: 1
        })
      );
    });
  });

  describe('HTTP server startup', () => {
    it('should handle port already in use error', async () => {
      const { createServer } = vi.mocked(await import('http'));

      const mockHttpServer = {
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn()
      };

      let errorHandler: any;
      mockHttpServer.on.mockImplementation((event, handler) => {
        if (event === 'error') errorHandler = handler;
        return mockHttpServer;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        // Simulate error before callback
        const error = new Error('Port in use') as any;
        error.code = 'EADDRINUSE';
        errorHandler(error);
        return mockHttpServer;
      });

      vi.mocked(createServer).mockReturnValue(mockHttpServer as any);

      const servers = createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      await expect(servers.start(4000)).rejects.toThrow(
        'Port 4000 is already in use. Please ensure no other process is using this port or change GRAPHQL_PORT in your .env file.'
      );
    });

    it('should handle generic server errors', async () => {
      const { createServer } = vi.mocked(await import('http'));

      const mockHttpServer = {
        listen: vi.fn(),
        close: vi.fn(),
        on: vi.fn()
      };

      let errorHandler: any;
      mockHttpServer.on.mockImplementation((event, handler) => {
        if (event === 'error') errorHandler = handler;
        return mockHttpServer;
      });

      mockHttpServer.listen.mockImplementation((port, callback) => {
        // Simulate generic error
        errorHandler(new Error('Generic server error'));
        return mockHttpServer;
      });

      vi.mocked(createServer).mockReturnValue(mockHttpServer as any);

      const servers = createGraphQLServers(mockSchema, mockSubscriberManager, {
        graphiqlEnabled: false
      });

      await expect(servers.start(4000)).rejects.toThrow('Generic server error');
    });
  });
});