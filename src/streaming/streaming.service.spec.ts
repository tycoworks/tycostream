import { Test, TestingModule } from '@nestjs/testing';
import { StreamingService } from './streaming.service';
import { DatabaseConnectionService } from '../database/connection.service';
import type { SourceDefinition } from '../config/source.types';
import type { ProtocolHandler } from '../database/types';
import { DatabaseRowUpdateType } from '../database/types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';

describe('StreamingService', () => {
  let service: StreamingService;
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
    service = new StreamingService(
      connectionService as any,
      mockSourceDef,
      'test_source',
      mockProtocolHandler
    );
    
    // Mock the startStreaming method to prevent actual database connection
    jest.spyOn(service as any, 'startStreaming').mockResolvedValue(undefined);
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
      
      service['processUpdate'](row, BigInt(1000), DatabaseRowUpdateType.Upsert);

      expect(service.getRowCount()).toBe(1);
    });

    it('should remove from cache on delete', () => {
      const row = { id: '1', name: 'test', value: 100 };
      
      // First insert
      service['processUpdate'](row, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      expect(service.getRowCount()).toBe(1);
      
      // Then delete
      service['processUpdate'](row, BigInt(2000), DatabaseRowUpdateType.Delete);
      
      expect(service.getRowCount()).toBe(0);
    });

    it('should normalize delete events to only contain primary key', () => {
      const fullRow = { id: '1', name: 'test', value: 100, extra: 'data' };
      let emittedEvent: RowUpdateEvent | null = null;
      
      // Subscribe to capture emitted events
      service.getUpdates().subscribe(event => {
        emittedEvent = event;
      });
      
      // Process delete with full row data
      service['processUpdate'](fullRow, BigInt(1000), DatabaseRowUpdateType.Delete);
      
      // Verify the emitted delete event only contains primary key
      expect(emittedEvent).toBeDefined();
      expect(emittedEvent!.type).toBe(RowUpdateType.Delete);
      expect(emittedEvent!.fields).toEqual({ id: '1' });
      expect(Object.keys(emittedEvent!.fields)).toEqual(['id']);
    });

    it('should calculate changes for updates', () => {
      let emittedEvents: RowUpdateEvent[] = [];
      
      // Subscribe to capture all events
      service.getUpdates().subscribe(event => {
        emittedEvents.push(event);
      });
      
      // First insert
      service['processUpdate']({ id: '1', name: 'original', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Update with some changes
      service['processUpdate']({ id: '1', name: 'updated', value: 100 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      // Verify INSERT has full data
      expect(emittedEvents[0].type).toBe(RowUpdateType.Insert);
      expect(emittedEvents[0].fields).toEqual({ id: '1', name: 'original', value: 100 });
      
      // Verify UPDATE has only changes (changed fields + pk)
      expect(emittedEvents[1].type).toBe(RowUpdateType.Update);
      expect(emittedEvents[1].fields).toEqual({ id: '1', name: 'updated' });
    });

    it('should track latest timestamp', () => {
      expect(service.currentTimestamp).toBe(BigInt(0));
      
      service['processUpdate']({ id: '1' }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      expect(service.currentTimestamp).toBe(BigInt(1000));
      
      service['processUpdate']({ id: '1' }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      expect(service.currentTimestamp).toBe(BigInt(2000));
    });
  });

  describe('getUpdates - late joiner support', () => {
    it('should send cache snapshot to new subscribers', async () => {
      // Pre-populate cache
      service['processUpdate']({ id: '1', name: 'test1', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      service['processUpdate']({ id: '2', name: 'test2', value: 200 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
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
        fields: { id: '1', name: 'test1', value: 100 }
      });
      expect(events[1]).toEqual({
        type: RowUpdateType.Insert,
        fields: { id: '2', name: 'test2', value: 200 }
      });
    });

    it('should not duplicate events for late joiners', async () => {
      // Initial data
      service['processUpdate']({ id: '1', name: 'initial', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // First subscriber
      const firstSub = service.getUpdates();
      const firstEvents: RowUpdateEvent[] = [];
      const firstSubscription = firstSub.subscribe(event => firstEvents.push(event));
      
      // Update happens after first subscriber
      service['processUpdate']({ id: '1', name: 'updated', value: 200 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      // Second subscriber joins after update
      const secondSub = service.getUpdates();
      const secondEvents: RowUpdateEvent[] = [];
      const secondSubscription = secondSub.subscribe(event => secondEvents.push(event));
      
      // New update after both subscribers
      service['processUpdate']({ id: '1', name: 'final', value: 300 }, BigInt(3000), DatabaseRowUpdateType.Upsert);
      
      // Give time to process
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // First subscriber should have: initial (snapshot) + updated + final
      expect(firstEvents).toHaveLength(3);
      expect(firstEvents[0].fields.name).toBe('initial');
      expect(firstEvents[1].fields.name).toBe('updated');
      expect(firstEvents[2].fields.name).toBe('final');
      
      // Second subscriber should have: updated (snapshot) + final
      expect(secondEvents).toHaveLength(2);
      expect(secondEvents[0].fields.name).toBe('updated'); // Current cache state
      expect(secondEvents[1].fields.name).toBe('final');   // New update
      
      firstSubscription.unsubscribe();
      secondSubscription.unsubscribe();
    });

    it('should filter updates by timestamp correctly', async () => {
      // Process some updates
      service['processUpdate']({ id: '1', value: 1 }, BigInt(100), DatabaseRowUpdateType.Upsert);
      
      service['processUpdate']({ id: '1', value: 2 }, BigInt(200), DatabaseRowUpdateType.Upsert);
      
      // Subscribe (snapshot taken at timestamp 200)
      const updates$ = service.getUpdates();
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));
      
      // These should be filtered out (same or earlier timestamp)
      service['processUpdate']({ id: '1', value: 3 }, BigInt(200), DatabaseRowUpdateType.Upsert); // Same timestamp - should be filtered
      
      service['processUpdate']({ id: '1', value: 4 }, BigInt(150), DatabaseRowUpdateType.Upsert); // Earlier timestamp - should be filtered
      
      // This should pass through
      service['processUpdate']({ id: '1', value: 5 }, BigInt(300), DatabaseRowUpdateType.Upsert); // Later timestamp - should pass
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Should have snapshot + only the last update
      expect(events).toHaveLength(2);
      expect(events[0].fields.value).toBe(2); // Snapshot
      expect(events[1].fields.value).toBe(5); // Only update with timestamp > 200
      
      subscription.unsubscribe();
    });
  });

  describe('multi-field update scenarios', () => {
    it('should send only changed fields for partial updates', () => {
      // Initial insert with multiple fields
      service['processUpdate'](
        { id: '1', name: 'Alice', email: 'alice@test.com', age: 30, active: true },
        BigInt(100),
        DatabaseRowUpdateType.Upsert
      );

      const updates$ = service.getUpdates();
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // Update only email and age
      service['processUpdate'](
        { id: '1', name: 'Alice', email: 'alice@example.com', age: 31, active: true },
        BigInt(200),
        DatabaseRowUpdateType.Upsert
      );

      // Should only include changed fields + primary key
      expect(events[1].type).toBe(RowUpdateType.Update);
      expect(events[1].fields).toEqual({
        id: '1',
        email: 'alice@example.com',
        age: 31
      });
      expect(events[1].fields).not.toHaveProperty('name');
      expect(events[1].fields).not.toHaveProperty('active');

      subscription.unsubscribe();
    });

    it('should handle updates where no fields change', () => {
      service['processUpdate'](
        { id: '1', name: 'Bob', value: 100 },
        BigInt(100),
        DatabaseRowUpdateType.Upsert
      );

      const updates$ = service.getUpdates();
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // Update with same values
      service['processUpdate'](
        { id: '1', name: 'Bob', value: 100 },
        BigInt(200),
        DatabaseRowUpdateType.Upsert
      );

      // Should still emit update with just primary key
      expect(events[1].type).toBe(RowUpdateType.Update);
      expect(events[1].fields).toEqual({ id: '1' });

      subscription.unsubscribe();
    });

    it('should handle updates where all fields change', () => {
      service['processUpdate'](
        { id: '1', name: 'Charlie', value: 100, status: 'active' },
        BigInt(100),
        DatabaseRowUpdateType.Upsert
      );

      const updates$ = service.getUpdates();
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // Update all fields
      service['processUpdate'](
        { id: '1', name: 'Charles', value: 200, status: 'inactive' },
        BigInt(200),
        DatabaseRowUpdateType.Upsert
      );

      // Should include all changed fields
      expect(events[1].type).toBe(RowUpdateType.Update);
      expect(events[1].fields).toEqual({
        id: '1',
        name: 'Charles',
        value: 200,
        status: 'inactive'
      });

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
    it('should track row count correctly', () => {
      service['processUpdate']({ id: '1', name: 'test1' }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      service['processUpdate']({ id: '2', name: 'test2' }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      expect(service.getRowCount()).toBe(2);
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