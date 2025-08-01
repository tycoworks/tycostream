import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { StreamingManagerService } from './manager.service';
import { DatabaseConnectionService } from '../database/connection.service';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import { firstValueFrom, take } from 'rxjs';

describe('StreamingManagerService', () => {
  let managerService: StreamingManagerService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockConnectionService: jest.Mocked<DatabaseConnectionService>;

  const mockSourceDefs = new Map<string, SourceDefinition>([
    ['trades', {
      name: 'trades',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: 'text' },
        { name: 'symbol', type: 'text' },
        { name: 'price', type: 'numeric' }
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

  const mockClient = {
    query: jest.fn(),
    end: jest.fn()
  };

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn()
    } as any;

    mockConnectionService = {
      connect: jest.fn().mockResolvedValue(mockClient),
      disconnect: jest.fn().mockResolvedValue(undefined)
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StreamingManagerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: DatabaseConnectionService, useValue: mockConnectionService }
      ]
    }).compile();

    managerService = module.get<StreamingManagerService>(StreamingManagerService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should be defined', () => {
      expect(managerService).toBeDefined();
    });

    it('should load source definitions on module init', async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);

      await managerService.onModuleInit();

      expect(mockConfigService.get).toHaveBeenCalledWith('sources');
      expect(managerService.getAvailableSources()).toEqual(['trades', 'live_pnl']);
    });

    it('should handle no source definitions gracefully', async () => {
      mockConfigService.get.mockReturnValue(new Map());

      await managerService.onModuleInit();

      expect(managerService.getAvailableSources()).toEqual([]);
    });

    it('should handle undefined source definitions', async () => {
      mockConfigService.get.mockReturnValue(undefined);

      await managerService.onModuleInit();

      expect(managerService.getAvailableSources()).toEqual([]);
    });
  });

  describe('source management', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should return available source names', () => {
      const sources = managerService.getAvailableSources();
      expect(sources).toEqual(['trades', 'live_pnl']);
    });

    it('should return source definition for valid source', () => {
      const sourceDef = managerService.getSourceDefinition('trades');
      expect(sourceDef).toEqual(mockSourceDefs.get('trades'));
    });

    it('should return undefined for invalid source', () => {
      const sourceDef = managerService.getSourceDefinition('invalid');
      expect(sourceDef).toBeUndefined();
    });
  });

  describe('streaming service creation', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should create streaming service for valid source', () => {
      // Mock the query to avoid connection issues in tests
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      const updates$ = managerService.getUpdates('trades');
      
      expect(updates$).toBeDefined();
      expect(managerService._getStreamingServiceCount()).toBe(1);
      expect(managerService._getStreamingService('trades')).toBeDefined();
    });

    it('should reuse existing streaming service', () => {
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      // Get updates twice
      managerService.getUpdates('trades');
      managerService.getUpdates('trades');
      
      // Should still only have one service
      expect(managerService._getStreamingServiceCount()).toBe(1);
    });

    it('should create separate services for different sources', () => {
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      managerService.getUpdates('trades');
      managerService.getUpdates('live_pnl');
      
      expect(managerService._getStreamingServiceCount()).toBe(2);
      expect(managerService._getStreamingService('trades')).toBeDefined();
      expect(managerService._getStreamingService('live_pnl')).toBeDefined();
    });

    it('should throw error for unknown source', () => {
      expect(() => {
        managerService.getUpdates('unknown_source');
      }).toThrow('Unknown source: unknown_source. Available sources: trades, live_pnl');
    });
  });


  describe('lifecycle management', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should stop streaming for specific source', async () => {
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      // Create a streaming service
      managerService.getUpdates('trades');
      expect(managerService._getStreamingServiceCount()).toBe(1);
      
      // Stop streaming
      await managerService.stopStreaming('trades');
      expect(managerService._getStreamingService('trades')).toBeUndefined();
      expect(managerService._getStreamingServiceCount()).toBe(0);
    });

    it('should handle stopping non-existent source gracefully', async () => {
      await expect(managerService.stopStreaming('non_existent')).resolves.toBeUndefined();
    });

    it('should clean up all services on module destroy', async () => {
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      // Create multiple streaming services
      managerService.getUpdates('trades');
      managerService.getUpdates('live_pnl');
      expect(managerService._getStreamingServiceCount()).toBe(2);
      
      // Destroy module
      await managerService.onModuleDestroy();
      expect(managerService._getStreamingServiceCount()).toBe(0);
    });
  });

  describe('integration', () => {
    beforeEach(async () => {
      mockConfigService.get.mockReturnValue(mockSourceDefs);
      await managerService.onModuleInit();
    });

    it('should create streaming service even with connection issues', () => {
      // Should not throw when creating a streaming service
      const updates$ = managerService.getUpdates('trades');
      expect(updates$).toBeDefined();
      
      // Service should be created
      expect(managerService._getStreamingService('trades')).toBeDefined();
      expect(managerService._getStreamingServiceCount()).toBe(1);
    });

    it('should provide Observable interface for updates', async () => {
      const mockStream = { on: jest.fn() };
      mockClient.query.mockReturnValue(mockStream);

      const updates$ = managerService.getUpdates('trades');
      
      // Should be able to subscribe
      const subscription = updates$.subscribe({
        next: (event: RowUpdateEvent) => {
          expect(event).toHaveProperty('type');
          expect(event).toHaveProperty('row');
        }
      });

      // Should support RxJS operators
      const firstUpdate$ = updates$.pipe(take(1));
      expect(firstUpdate$).toBeDefined();

      subscription.unsubscribe();
    });
  });
});