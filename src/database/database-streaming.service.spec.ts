import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseStreamingService } from './database-streaming.service';
import { DatabaseConnectionService } from './database-connection.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { ProtocolHandler } from './types';

describe('DatabaseStreamingService', () => {
  let service: DatabaseStreamingService;
  let connectionService: DatabaseConnectionService;

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

  const mockConnectionService = {
    connect: jest.fn().mockResolvedValue(mockClient),
    disconnect: jest.fn().mockResolvedValue(undefined)
  };

  const mockProtocolHandler: ProtocolHandler = {
    createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test_source'),
    parseLine: jest.fn()
  };

  beforeEach(async () => {
    // Create service directly with constructor since it needs source info
    connectionService = mockConnectionService as any;
    service = new DatabaseStreamingService(
      connectionService as any,
      mockSourceDef,
      'test_source',
      mockProtocolHandler
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getUpdates', () => {
    it('should return an Observable', () => {
      const updates$ = service.getUpdates();
      expect(updates$).toBeDefined();
      expect(updates$.subscribe).toBeDefined();
    });
  });

  describe('getAllRows', () => {
    it('should return empty array initially', () => {
      expect(service.getAllRows()).toEqual([]);
    });
  });

  describe('getRow', () => {
    it('should return undefined for non-existent row', () => {
      expect(service.getRow('non-existent')).toBeUndefined();
    });
  });

  describe('getCacheSize', () => {
    it('should return 0 initially', () => {
      expect(service.getCacheSize()).toBe(0);
    });
  });

  describe('streaming', () => {
    it('should return false initially', () => {
      expect(service.streaming).toBe(false);
    });
  });
});