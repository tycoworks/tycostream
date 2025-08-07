import { DatabaseStream } from './subscriber';
import type { DatabaseConfig } from '../config/database.config';
import type { SourceDefinition } from '../config/source.types';
import type { ProtocolHandler } from './types';
import { DatabaseRowUpdateType } from './types';
import { Client } from 'pg';

// Mock pg module
jest.mock('pg', () => {
  return { 
    Client: jest.fn()
  };
});

describe('DatabaseStream', () => {
  let stream: DatabaseStream;
  let mockConfig: DatabaseConfig;
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
    connect: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined)
  };

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.end.mockResolvedValue(undefined);
    mockClient.query.mockClear();
    
    // Reset pg Client mock
    (Client as unknown as jest.Mock).mockImplementation(() => mockClient);
    
    mockConfig = {
      host: 'localhost',
      port: 6875,
      database: 'materialize',
      user: 'test',
      password: 'test',
    };

    mockProtocolHandler = {
      createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test_source'),
      parseLine: jest.fn()
    };

    stream = new DatabaseStream(
      mockConfig,
      'test_source',
      mockProtocolHandler
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(stream).toBeDefined();
    });

    it('should not be streaming initially', () => {
      expect(stream.streaming).toBe(false);
    });
  });

  describe('connect', () => {
    it('should connect to database and create subscribe query', async () => {
      const mockUpdateCallback = jest.fn();
      const mockErrorCallback = jest.fn();

      // Mock successful connection and query
      const mockStream = {
        on: jest.fn()
      };
      mockClient.query.mockReturnValue(mockStream);

      await stream.connect(mockUpdateCallback, mockErrorCallback);

      expect(Client).toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalled();
      expect(mockProtocolHandler.createSubscribeQuery).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.objectContaining({}) // pg-copy-streams object
      );
      expect(stream.streaming).toBe(true);
    });

    it('should not start streaming if already active', async () => {
      const mockUpdateCallback = jest.fn();
      
      // First call
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await stream.connect(mockUpdateCallback);

      // Second call should not connect again
      jest.clearAllMocks();
      await stream.connect(mockUpdateCallback);

      expect(Client).not.toHaveBeenCalled();
    });

    it('should handle connection errors', async () => {
      const mockUpdateCallback = jest.fn();
      const connectionError = new Error('Connection failed');
      
      mockClient.connect.mockRejectedValue(connectionError);

      await expect(stream.connect(mockUpdateCallback)).rejects.toThrow('Database connection failed: Connection failed');
      // Note: streaming might be briefly true before error occurs, depending on timing
    });
  });

  describe('onModuleDestroy', () => {
    it('should disconnect client when streaming', async () => {
      const mockUpdateCallback = jest.fn();
      
      // Start streaming
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await stream.connect(mockUpdateCallback);

      // Destroy
      await stream.onModuleDestroy();

      expect(mockClient.end).toHaveBeenCalled();
    });

    it('should handle disconnect errors gracefully', async () => {
      const mockUpdateCallback = jest.fn();
      
      // Start streaming
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);
      await stream.connect(mockUpdateCallback);

      // Mock client.end() error
      mockClient.end.mockRejectedValue(new Error('Disconnect failed'));

      // Should not throw
      await expect(stream.onModuleDestroy()).resolves.toBeUndefined();
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
        updateType: DatabaseRowUpdateType.Upsert
      });

      await stream.connect(mockUpdateCallback);

      // Simulate receiving data
      const chunk = Buffer.from('test line\n');
      dataCallback!(chunk);

      expect(mockUpdateCallback).toHaveBeenCalledWith(
        { id: '1', name: 'test' },
        BigInt(1000),
        DatabaseRowUpdateType.Upsert
      );
    });

    it('should call update callback with delete type when appropriate', async () => {
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
        updateType: DatabaseRowUpdateType.Delete
      });

      await stream.connect(mockUpdateCallback);

      const chunk = Buffer.from('delete line\n');
      dataCallback!(chunk);

      expect(mockUpdateCallback).toHaveBeenCalledWith(
        { id: '1', name: 'test' },
        BigInt(1000),
        DatabaseRowUpdateType.Delete
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

      await stream.connect(mockUpdateCallback);

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

      await stream.connect(mockUpdateCallback, mockErrorCallback);

      // Simulate stream error
      const error = new Error('Database connection lost');
      errorCallback!(error);
      
      expect(mockErrorCallback).toHaveBeenCalledWith(error);
      expect(stream.streaming).toBe(false);
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

      await stream.connect(mockUpdateCallback, mockErrorCallback);

      // Simulate unexpected stream end
      endCallback!();
      
      expect(mockErrorCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Database stream ended unexpectedly')
        })
      );
      expect(stream.streaming).toBe(false);
    });
  });
});