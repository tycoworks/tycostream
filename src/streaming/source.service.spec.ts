import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SourceService } from './source.service';
import { DatabaseStreamService } from '../database/stream.service';
import type { SourceDefinition } from '../config/source.types';

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
        { name: 'trade_id', type: 'text' },
        { name: 'symbol', type: 'text' },
        { name: 'quantity', type: 'integer' }
      ]
    }],
    ['live_pnl', {
      name: 'live_pnl',
      primaryKeyField: 'account_id',
      fields: [
        { name: 'account_id', type: 'text' },
        { name: 'pnl', type: 'numeric' }
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
      const tradesCleanup = jest.spyOn(tradesService, 'onModuleDestroy');
      const pnlCleanup = jest.spyOn(pnlService, 'onModuleDestroy');
      
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