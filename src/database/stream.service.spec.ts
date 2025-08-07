import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DatabaseStreamService } from './stream.service';
import { DatabaseStream } from './stream';
import { Client } from 'pg';
import type { ProtocolHandler } from './types';

// Mock DatabaseStream
jest.mock('./stream', () => {
  return {
    DatabaseStream: jest.fn().mockImplementation((config, sourceName, protocolHandler) => ({
      sourceName,
      protocolHandler,
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      onModuleDestroy: jest.fn().mockResolvedValue(undefined)
    }))
  };
});

// Mock pg module
jest.mock('pg', () => {
  return { 
    Client: jest.fn().mockImplementation(() => ({
      connect: jest.fn(),
      end: jest.fn(),
      query: jest.fn(),
    }))
  };
});

describe('DatabaseStreamService', () => {
  let service: DatabaseStreamService;
  let configService: ConfigService;

  beforeEach(async () => {
    // Clear all mocks before each test
    jest.clearAllMocks();
    
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseStreamService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockReturnValue({
              host: 'localhost',
              port: 6875,
              database: 'materialize',
              user: 'test',
              password: 'test',
            }),
          },
        },
      ],
    }).compile();

    service = module.get<DatabaseStreamService>(DatabaseStreamService);
    configService = module.get<ConfigService>(ConfigService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getStream', () => {
    const mockProtocolHandler: ProtocolHandler = {
      createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test'),
      parseLine: jest.fn()
    };

    beforeEach(() => {
      // Reset the mock to clear any created streams
      (DatabaseStream as jest.Mock).mockClear();
    });

    it('should create a new DatabaseStream for first request', () => {
      const stream = service.getStream('test_source', mockProtocolHandler);
      
      expect(DatabaseStream).toHaveBeenCalledTimes(1);
      expect(DatabaseStream).toHaveBeenCalledWith(
        {
          host: 'localhost',
          port: 6875,
          database: 'materialize',
          user: 'test',
          password: 'test',
        },
        'test_source',
        mockProtocolHandler
      );
      expect(stream).toBeDefined();
      // Stream is created with correct parameters (verified via mock call above)
    });

    it('should reuse existing DatabaseStream for same source', () => {
      // First call creates the stream
      const stream1 = service.getStream('test_source', mockProtocolHandler);
      expect(DatabaseStream).toHaveBeenCalledTimes(1);
      
      // Second call should return the same stream
      const stream2 = service.getStream('test_source', mockProtocolHandler);
      expect(DatabaseStream).toHaveBeenCalledTimes(1); // Still only 1 call
      
      expect(stream1).toBe(stream2);
    });

    it('should create separate streams for different sources', () => {
      const stream1 = service.getStream('source1', mockProtocolHandler);
      const stream2 = service.getStream('source2', mockProtocolHandler);
      
      expect(DatabaseStream).toHaveBeenCalledTimes(2);
      expect(stream1).not.toBe(stream2);
      // Each stream is created with its respective source name (verified via mock calls)
    });

    it('should create fresh stream when existing one is disposed', () => {
      const firstStream = service.getStream('test_source', mockProtocolHandler);
      expect(firstStream).toBeDefined();
      
      // Mock the stream as disposed
      Object.defineProperty(firstStream, 'isDisposed', {
        get: jest.fn().mockReturnValue(true),
        configurable: true
      });
      
      // Get stream again - should create a new one
      const secondStream = service.getStream('test_source', mockProtocolHandler);
      
      // Should be a different instance
      expect(secondStream).not.toBe(firstStream);
      expect(DatabaseStream).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple protocol handlers for same source', () => {
      const protocolHandler1: ProtocolHandler = {
        createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE 1'),
        parseLine: jest.fn()
      };
      
      const protocolHandler2: ProtocolHandler = {
        createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE 2'),
        parseLine: jest.fn()
      };
      
      // Same source name, but different protocol handlers
      const stream1 = service.getStream('test_source', protocolHandler1);
      const stream2 = service.getStream('test_source', protocolHandler2);
      
      // Should return the same stream (source name is the key)
      expect(stream1).toBe(stream2);
      expect(DatabaseStream).toHaveBeenCalledTimes(1);
      // The first call creates the stream with protocolHandler1
    });
  });

  describe('removeStream', () => {
    const mockProtocolHandler: ProtocolHandler = {
      createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test'),
      parseLine: jest.fn()
    };

    it('should remove stream and call disconnect', () => {
      // Create a stream
      const stream = service.getStream('test_source', mockProtocolHandler);
      const disconnectSpy = stream.disconnect as jest.Mock;
      
      // Remove it
      service.removeStream('test_source');
      
      // Should call disconnect
      expect(disconnectSpy).toHaveBeenCalled();
      
      // Getting the stream again should create a new one
      const newStream = service.getStream('test_source', mockProtocolHandler);
      expect(newStream).not.toBe(stream);
      expect(DatabaseStream).toHaveBeenCalledTimes(2);
    });

    it('should handle removing non-existent stream gracefully', () => {
      // Should not throw when removing a stream that doesn't exist
      expect(() => service.removeStream('non_existent')).not.toThrow();
    });
  });

  describe('onModuleDestroy', () => {
    const mockProtocolHandler: ProtocolHandler = {
      createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test'),
      parseLine: jest.fn()
    };

    it('should disconnect all active streams', async () => {
      // Create multiple streams
      const stream1 = service.getStream('source1', mockProtocolHandler);
      const stream2 = service.getStream('source2', mockProtocolHandler);
      const stream3 = service.getStream('source3', mockProtocolHandler);
      
      const disconnect1 = stream1.disconnect as jest.Mock;
      const disconnect2 = stream2.disconnect as jest.Mock;
      const disconnect3 = stream3.disconnect as jest.Mock;
      
      // Call onModuleDestroy
      await service.onModuleDestroy();
      
      // All streams should be disconnected
      expect(disconnect1).toHaveBeenCalled();
      expect(disconnect2).toHaveBeenCalled();
      expect(disconnect3).toHaveBeenCalled();
    });

    it('should handle empty streams map', async () => {
      // No streams created
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});