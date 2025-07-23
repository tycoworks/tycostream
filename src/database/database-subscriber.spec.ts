import { DatabaseSubscriber } from './database-subscriber';
import { DatabaseConnectionService } from './database-connection.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { ProtocolHandler } from './types';

describe('DatabaseSubscriber', () => {
  let subscriber: DatabaseSubscriber;
  let mockConnectionService: jest.Mocked<DatabaseConnectionService>;
  let mockProtocolHandler: jest.Mocked<ProtocolHandler>;

  const mockSourceDef: SourceDefinition = {
    name: 'test_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', type: 'text' },
      { name: 'name', type: 'text' },
      { name: 'value', type: 'integer' }
    ]
  };

  const mockClient = {
    query: jest.fn(),
    end: jest.fn()
  };

  beforeEach(() => {
    mockConnectionService = {
      connect: jest.fn().mockResolvedValue(mockClient),
      disconnect: jest.fn().mockResolvedValue(undefined)
    } as any;

    mockProtocolHandler = {
      createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test_source'),
      parseLine: jest.fn()
    };

    subscriber = new DatabaseSubscriber(
      mockConnectionService,
      'test_source',
      mockProtocolHandler
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(subscriber).toBeDefined();
    });

    it('should not be streaming initially', () => {
      expect(subscriber.streaming).toBe(false);
    });
  });

  describe('startStreaming', () => {
    it('should connect to database and create subscribe query', async () => {
      const mockUpdateCallback = jest.fn();
      const mockErrorCallback = jest.fn();

      // Mock successful connection and query
      const mockStream = {
        on: jest.fn()
      };
      mockClient.query.mockReturnValue(mockStream);

      await subscriber.startStreaming(mockUpdateCallback, mockErrorCallback);

      expect(mockConnectionService.connect).toHaveBeenCalled();
      expect(mockProtocolHandler.createSubscribeQuery).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.objectContaining({}) // pg-copy-streams object
      );
      expect(subscriber.streaming).toBe(true);
    });

    it('should not start streaming if already active', async () => {
      const mockUpdateCallback = jest.fn();
      
      // First call
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await subscriber.startStreaming(mockUpdateCallback);

      // Second call should not connect again
      mockConnectionService.connect.mockClear();
      await subscriber.startStreaming(mockUpdateCallback);

      expect(mockConnectionService.connect).not.toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const mockUpdateCallback = jest.fn();
      const connectionError = new Error('Connection failed');
      
      mockConnectionService.connect.mockRejectedValue(connectionError);

      await expect(subscriber.startStreaming(mockUpdateCallback)).rejects.toThrow('Connection failed');
      // Note: streaming might be briefly true before error occurs, depending on timing
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect client when streaming', async () => {
      const mockUpdateCallback = jest.fn();
      
      // Start streaming
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await subscriber.startStreaming(mockUpdateCallback);

      // Destroy
      await subscriber.onModuleDestroy();

      expect(mockConnectionService.disconnect).toHaveBeenCalledWith(mockClient);
    });

    it('should handle disconnect errors gracefully', async () => {
      const mockUpdateCallback = jest.fn();
      
      // Start streaming
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await subscriber.startStreaming(mockUpdateCallback);

      // Mock disconnect error
      mockConnectionService.disconnect.mockRejectedValue(new Error('Disconnect failed'));

      // Should not throw
      await expect(subscriber.onModuleDestroy()).resolves.toBeUndefined();
    });
  });

  describe('protocol integration', () => {
    it('should call update callback when line is parsed successfully', async () => {
      const mockUpdateCallback = jest.fn();
      let dataCallback: (chunk: Buffer) => void;
      
      // Mock stream setup
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            dataCallback = callback;
          }
        })
      };
      mockClient.query.mockReturnValue(mockStream);

      // Mock protocol parsing
      mockProtocolHandler.parseLine.mockReturnValue({
        row: { id: '1', name: 'test' },
        timestamp: BigInt(1000),
        isDelete: false
      });

      await subscriber.startStreaming(mockUpdateCallback);

      // Simulate receiving data
      const chunk = Buffer.from('test line\n');
      dataCallback!(chunk);

      expect(mockUpdateCallback).toHaveBeenCalledWith(
        { id: '1', name: 'test' },
        BigInt(1000),
        false
      );
    });

    it('should call update callback with delete flag when appropriate', async () => {
      const mockUpdateCallback = jest.fn();
      let dataCallback: (chunk: Buffer) => void;
      
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            dataCallback = callback;
          }
        })
      };
      mockClient.query.mockReturnValue(mockStream);

      // Mock delete event
      mockProtocolHandler.parseLine.mockReturnValue({
        row: { id: '1', name: 'test' },
        timestamp: BigInt(1000),
        isDelete: true
      });

      await subscriber.startStreaming(mockUpdateCallback);

      const chunk = Buffer.from('delete line\n');
      dataCallback!(chunk);

      expect(mockUpdateCallback).toHaveBeenCalledWith(
        { id: '1', name: 'test' },
        BigInt(1000),
        true
      );
    });

    it('should not call callback if line parsing fails', async () => {
      const mockUpdateCallback = jest.fn();
      let dataCallback: (chunk: Buffer) => void;
      
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            dataCallback = callback;
          }
        })
      };
      mockClient.query.mockReturnValue(mockStream);

      // Mock parsing failure
      mockProtocolHandler.parseLine.mockReturnValue(null);

      await subscriber.startStreaming(mockUpdateCallback);

      const chunk = Buffer.from('invalid line\n');
      dataCallback!(chunk);

      expect(mockUpdateCallback).not.toHaveBeenCalled();
    });
  });

  describe('error propagation', () => {
    it('should call error callback on stream error', async () => {
      const mockUpdateCallback = jest.fn();
      const mockErrorCallback = jest.fn();
      
      let errorCallback: (error: Error) => void;
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === 'error') {
            errorCallback = callback;
          }
        })
      };
      mockClient.query.mockReturnValue(mockStream);

      await subscriber.startStreaming(mockUpdateCallback, mockErrorCallback);

      // Simulate stream error
      const error = new Error('Database connection lost');
      errorCallback!(error);
      
      expect(mockErrorCallback).toHaveBeenCalledWith(error);
      expect(subscriber.streaming).toBe(false);
    });

    it('should call error callback on unexpected stream end', async () => {
      const mockUpdateCallback = jest.fn();
      const mockErrorCallback = jest.fn();
      
      let endCallback: () => void;
      const mockStream = {
        on: jest.fn((event, callback) => {
          if (event === 'end') {
            endCallback = callback;
          }
        })
      };
      mockClient.query.mockReturnValue(mockStream);

      await subscriber.startStreaming(mockUpdateCallback, mockErrorCallback);

      // Simulate unexpected stream end
      endCallback!();
      
      expect(mockErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Database stream ended unexpectedly')
        })
      );
      expect(subscriber.streaming).toBe(false);
    });
  });
});