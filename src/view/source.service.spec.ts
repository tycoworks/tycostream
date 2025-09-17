import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SourceService } from './source.service';
import { DatabaseStreamService } from '../database/stream.service';
import type { SourceDefinition } from '../config/source.types';
import { DataType, FieldType } from '../config/source.types';

describe('SourceService', () => {
  let sourceService: SourceService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockConnectionService: jest.Mocked<DatabaseStreamService>;
  let mockClient: any;

  const mockSourceDefs = new Map<string, SourceDefinition>([
    ['trades', {
      name: 'trades',
      primaryKeyField: 'trade_id',
      fields: [
        { name: 'trade_id', dataType: DataType.String, fieldType: FieldType.Scalar },
        { name: 'symbol', dataType: DataType.String, fieldType: FieldType.Scalar },
        { name: 'quantity', dataType: DataType.Integer, fieldType: FieldType.Scalar }
      ]
    }],
    ['live_pnl', {
      name: 'live_pnl',
      primaryKeyField: 'account_id',
      fields: [
        { name: 'account_id', dataType: DataType.String, fieldType: FieldType.Scalar },
        { name: 'pnl', dataType: DataType.Float, fieldType: FieldType.Scalar }
      ]
    }]
  ]);

  beforeEach(async () => {
    mockClient = {
      query: jest.fn(),
      release: jest.fn(),
      on: jest.fn(),
      removeAllListeners: jest.fn(),
      end: jest.fn()
    };

    mockConfigService = {
      get: jest.fn(),
    } as any;

    mockConnectionService = {
      getStream: jest.fn().mockReturnValue({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn(),
        streaming: false
      }),
      removeStream: jest.fn()
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SourceService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseStreamService, useValue: mockConnectionService },
      ],
    }).compile();

    sourceService = module.get<SourceService>(SourceService);
  });

  describe('initialization', () => {
    it('should load source definitions on module init', async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      
      await sourceService.onModuleInit();
      
      expect(mockConfigService.get).toHaveBeenCalledWith('sources');
    });

    it('should handle missing source definitions gracefully', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      
      // Should not throw
      await expect(sourceService.onModuleInit()).resolves.toBeUndefined();
    });

    it('should handle empty source definitions', async () => {
      mockConfigService.get.mockReturnValue(new Map());
      
      // Should not throw
      await expect(sourceService.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('getSource', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await sourceService.onModuleInit();
    });

    it('should create streaming service for valid source', () => {
      const streamingService = sourceService.getSource('trades');
      
      expect(streamingService).toBeDefined();
      expect(streamingService.getUpdates).toBeDefined();
      expect(streamingService.getPrimaryKeyField).toBeDefined();
    });

    it('should reuse existing streaming service for same source', () => {
      const firstService = sourceService.getSource('trades');
      const secondService = sourceService.getSource('trades');
      
      expect(firstService).toBe(secondService);
    });

    it('should create separate streaming services for different sources', () => {
      const tradesService = sourceService.getSource('trades');
      const pnlService = sourceService.getSource('live_pnl');
      
      expect(tradesService).not.toBe(pnlService);
    });

    it('should throw error for unknown source', () => {
      expect(() => {
        sourceService.getSource('unknown_source');
      }).toThrow('Unknown source: unknown_source. Available sources: trades, live_pnl');
    });

    it('should create fresh source when existing one is disposed', () => {
      // Get initial source
      const firstSource = sourceService.getSource('trades');
      expect(firstSource).toBeDefined();
      
      // Mock the source as disposed
      Object.defineProperty(firstSource, 'isDisposed', {
        get: jest.fn().mockReturnValue(true),
        configurable: true
      });
      
      // Get source again - should create a new one
      const secondSource = sourceService.getSource('trades');
      
      // Should be a different instance
      expect(secondSource).not.toBe(firstSource);
      expect(secondSource).toBeDefined();
    });
  });

  describe('removeSource', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await sourceService.onModuleInit();
    });

    it('should remove source and its database stream', () => {
      // Create a source first
      const source = sourceService.getSource('trades');
      expect(source).toBeDefined();
      
      // Remove it
      sourceService.removeSource('trades');
      
      // Verify database stream was removed
      expect(mockConnectionService.removeStream).toHaveBeenCalledWith('trades');
      
      // Getting the source again should create a new one
      const newSource = sourceService.getSource('trades');
      expect(newSource).not.toBe(source);
    });

    it('should handle removing non-existent source gracefully', () => {
      // Should not throw
      expect(() => sourceService.removeSource('non_existent')).not.toThrow();
      
      // Should not call removeStream for non-existent source
      expect(mockConnectionService.removeStream).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle management', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await sourceService.onModuleInit();
    });

    it('should clean up all services on module destroy', async () => {
      // Create streaming services
      const tradesService = sourceService.getSource('trades');
      const pnlService = sourceService.getSource('live_pnl');
      
      // Spy on their cleanup methods
      const tradesCleanup = jest.spyOn(tradesService, 'dispose');
      const pnlCleanup = jest.spyOn(pnlService, 'dispose');
      
      // Destroy module
      await sourceService.onModuleDestroy();
      
      // Verify cleanup was called
      expect(tradesCleanup).toHaveBeenCalled();
      expect(pnlCleanup).toHaveBeenCalled();
    });

    it('should handle destroy when no services exist', async () => {
      // Don't create any services
      await expect(sourceService.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});