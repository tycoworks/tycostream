import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseStreamingService } from './database-streaming.service';
import { DatabaseConnectionService } from './database-connection.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { ProtocolHandler } from './types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';

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

  describe('processUpdate (internal)', () => {
    it('should update cache on insert/update', () => {
      const row = { id: '1', name: 'test', value: 100 };
      
      service['processUpdate'](row, BigInt(1000), false);

      expect(service._getRow('1')).toEqual(row);
      expect(service.getRowCount()).toBe(1);
    });

    it('should remove from cache on delete', () => {
      const row = { id: '1', name: 'test', value: 100 };
      
      // First insert
      service['processUpdate'](row, BigInt(1000), false);
      
      expect(service.getRowCount()).toBe(1);
      
      // Then delete
      service['processUpdate'](row, BigInt(2000), true);
      
      expect(service._getRow('1')).toBeUndefined();
      expect(service.getRowCount()).toBe(0);
    });

    it('should track latest timestamp', () => {
      expect(service.currentTimestamp).toBe(BigInt(0));
      
      service['processUpdate']({ id: '1' }, BigInt(1000), false);
      
      expect(service.currentTimestamp).toBe(BigInt(1000));
      
      service['processUpdate']({ id: '1' }, BigInt(2000), false);
      
      expect(service.currentTimestamp).toBe(BigInt(2000));
    });
  });

  describe('getUpdates - late joiner support', () => {
    it('should send cache snapshot to new subscribers', async () => {
      // Pre-populate cache
      service['processUpdate']({ id: '1', name: 'test1', value: 100 }, BigInt(1000), false);
      
      service['processUpdate']({ id: '2', name: 'test2', value: 200 }, BigInt(2000), false);
      
      // Subscribe and collect initial events
      const events = await firstValueFrom(
        service.getUpdates().pipe(
          take(2),
          toArray()
        )
      );
      
      expect(events).toHaveLength(2);
      expect(events[0]).toEqual({
        type: RowUpdateType.Insert,
        row: { id: '1', name: 'test1', value: 100 }
      });
      expect(events[1]).toEqual({
        type: RowUpdateType.Insert,
        row: { id: '2', name: 'test2', value: 200 }
      });
    });

    it('should not duplicate events for late joiners', async () => {
      // Initial data
      service['processUpdate']({ id: '1', name: 'initial', value: 100 }, BigInt(1000), false);
      
      // First subscriber
      const firstSub = service.getUpdates();
      const firstEvents: RowUpdateEvent[] = [];
      const firstSubscription = firstSub.subscribe(event => firstEvents.push(event));
      
      // Update happens after first subscriber
      service['processUpdate']({ id: '1', name: 'updated', value: 200 }, BigInt(2000), false);
      
      // Second subscriber joins after update
      const secondSub = service.getUpdates();
      const secondEvents: RowUpdateEvent[] = [];
      const secondSubscription = secondSub.subscribe(event => secondEvents.push(event));
      
      // New update after both subscribers
      service['processUpdate']({ id: '1', name: 'final', value: 300 }, BigInt(3000), false);
      
      // Give time to process
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // First subscriber should have: initial (snapshot) + updated + final
      expect(firstEvents).toHaveLength(3);
      expect(firstEvents[0].row.name).toBe('initial');
      expect(firstEvents[1].row.name).toBe('updated');
      expect(firstEvents[2].row.name).toBe('final');
      
      // Second subscriber should have: updated (snapshot) + final
      expect(secondEvents).toHaveLength(2);
      expect(secondEvents[0].row.name).toBe('updated'); // Current cache state
      expect(secondEvents[1].row.name).toBe('final');   // New update
      
      firstSubscription.unsubscribe();
      secondSubscription.unsubscribe();
    });

    it('should filter updates by timestamp correctly', async () => {
      // Process some updates
      service['processUpdate']({ id: '1', value: 1 }, BigInt(100), false);
      
      service['processUpdate']({ id: '1', value: 2 }, BigInt(200), false);
      
      // Subscribe (snapshot taken at timestamp 200)
      const updates$ = service.getUpdates();
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));
      
      // These should be filtered out (same or earlier timestamp)
      service['processUpdate']({ id: '1', value: 3 }, BigInt(200), false); // Same timestamp - should be filtered
      
      service['processUpdate']({ id: '1', value: 4 }, BigInt(150), false); // Earlier timestamp - should be filtered
      
      // This should pass through
      service['processUpdate']({ id: '1', value: 5 }, BigInt(300), false); // Later timestamp - should pass
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should have snapshot + only the last update
      expect(events).toHaveLength(2);
      expect(events[0].row.value).toBe(2); // Snapshot
      expect(events[1].row.value).toBe(5); // Only update with timestamp > 200
      
      subscription.unsubscribe();
    });
  });

  describe('consumer tracking', () => {
    it('should track consumer count', () => {
      expect(service.consumerCount).toBe(0);
      
      service.getUpdates();
      expect(service.consumerCount).toBe(1);
      
      service.getUpdates();
      expect(service.consumerCount).toBe(2);
      
      service.getUpdates();
      expect(service.consumerCount).toBe(3);
    });

    it('should decrement consumer count on unsubscribe', () => {
      expect(service.consumerCount).toBe(0);
      
      const sub1 = service.getUpdates().subscribe();
      expect(service.consumerCount).toBe(1);
      
      const sub2 = service.getUpdates().subscribe();
      expect(service.consumerCount).toBe(2);
      
      sub1.unsubscribe();
      expect(service.consumerCount).toBe(1);
      
      sub2.unsubscribe();
      expect(service.consumerCount).toBe(0);
    });
  });

  describe('cache operations', () => {
    it('should provide cache access methods', () => {
      service['processUpdate']({ id: '1', name: 'test1' }, BigInt(1000), false);
      
      service['processUpdate']({ id: '2', name: 'test2' }, BigInt(2000), false);
      
      expect(service.getRowCount()).toBe(2);
      expect(service._getRow('1')).toEqual({ id: '1', name: 'test1' });
      expect(service._getRow('2')).toEqual({ id: '2', name: 'test2' });
      expect(service._getAllRows()).toHaveLength(2);
    });
  });

  describe('getUpdates', () => {
    it('should return an Observable', () => {
      const updates$ = service.getUpdates();
      expect(updates$).toBeDefined();
      expect(updates$.subscribe).toBeDefined();
    });
  });

  describe('getRowCount', () => {
    it('should return 0 initially', () => {
      expect(service.getRowCount()).toBe(0);
    });
  });

  describe('streaming', () => {
    it('should return false initially', () => {
      expect(service.streaming).toBe(false);
    });
  });

  describe('consumerCount', () => {
    it('should return 0 initially', () => {
      expect(service.consumerCount).toBe(0);
    });
  });
});