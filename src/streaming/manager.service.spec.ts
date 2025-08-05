import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StreamingManagerService } from './manager.service';
import { DatabaseConnectionService } from '../database/connection.service';
import type { SourceDefinition } from '../config/source.types';

describe('StreamingManagerService', () => {
  let managerService: StreamingManagerService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockConnectionService: jest.Mocked<DatabaseConnectionService>;
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
      getClient: jest.fn().mockResolvedValue(mockClient),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreamingManagerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseConnectionService, useValue: mockConnectionService },
      ],
    }).compile();

    managerService = module.get<StreamingManagerService>(StreamingManagerService);
  });

  describe('initialization', () => {
    it('should load source definitions on module init', async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      
      await managerService.onModuleInit();
      
      expect(mockConfigService.get).toHaveBeenCalledWith('sources');
    });

    it('should handle missing source definitions gracefully', async () => {
      mockConfigService.get.mockReturnValue(undefined);
      
      // Should not throw
      await expect(managerService.onModuleInit()).resolves.toBeUndefined();
    });

    it('should handle empty source definitions', async () => {
      mockConfigService.get.mockReturnValue(new Map());
      
      // Should not throw
      await expect(managerService.onModuleInit()).resolves.toBeUndefined();
    });
  });

  describe('getStreamingService', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should create streaming service for valid source', () => {
      const streamingService = managerService.getStreamingService('trades');
      
      expect(streamingService).toBeDefined();
      expect(streamingService.getUpdates).toBeDefined();
      expect(streamingService.getPrimaryKeyField).toBeDefined();
    });

    it('should reuse existing streaming service for same source', () => {
      const firstService = managerService.getStreamingService('trades');
      const secondService = managerService.getStreamingService('trades');
      
      expect(firstService).toBe(secondService);
    });

    it('should create separate streaming services for different sources', () => {
      const tradesService = managerService.getStreamingService('trades');
      const pnlService = managerService.getStreamingService('live_pnl');
      
      expect(tradesService).not.toBe(pnlService);
    });

    it('should throw error for unknown source', () => {
      expect(() => {
        managerService.getStreamingService('unknown_source');
      }).toThrow('Unknown source: unknown_source. Available sources: trades, live_pnl');
    });
  });

  describe('lifecycle management', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should clean up all services on module destroy', async () => {
      // Create streaming services
      const tradesService = managerService.getStreamingService('trades');
      const pnlService = managerService.getStreamingService('live_pnl');
      
      // Spy on their cleanup methods
      const tradesCleanup = jest.spyOn(tradesService, 'onModuleDestroy');
      const pnlCleanup = jest.spyOn(pnlService, 'onModuleDestroy');
      
      // Destroy module
      await managerService.onModuleDestroy();
      
      // Verify cleanup was called
      expect(tradesCleanup).toHaveBeenCalled();
      expect(pnlCleanup).toHaveBeenCalled();
    });

    it('should handle destroy when no services exist', async () => {
      // Don't create any services
      await expect(managerService.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});