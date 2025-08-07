import { StreamingService } from './streaming.service';
import { DatabaseStreamService } from '../database/connection.service';
import type { SourceDefinition } from '../config/source.types';
import type { ProtocolHandler } from '../database/types';
import { DatabaseRowUpdateType } from '../database/types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';

// Mock DatabaseStream before importing StreamingService
const mockDatabaseStream = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  onModuleDestroy: jest.fn().mockResolvedValue(undefined),
  streaming: false
};

jest.mock('../database/subscriber', () => {
  return {
    DatabaseStream: jest.fn().mockImplementation(() => mockDatabaseStream)
  };
});

describe('StreamingService', () => {
  let service: StreamingService;
  let streamService: DatabaseStreamService;

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

  const mockStreamService = {
    connect: jest.fn().mockResolvedValue(mockClient),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getStream: jest.fn().mockReturnValue(mockDatabaseStream),
    removeStream: jest.fn()
  };

  const mockProtocolHandler: ProtocolHandler = {
    createSubscribeQuery: jest.fn().mockReturnValue('SUBSCRIBE TO test_source'),
    parseLine: jest.fn()
  };

  beforeEach(() => {
    streamService = mockStreamService as any;
    service = new StreamingService(
      streamService as any,
      mockSourceDef,
      'test_source',
      mockProtocolHandler
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getUpdates', () => {
    it('should provide observable stream of row updates', () => {
      const updates$ = service.getUpdates();
      expect(updates$).toBeDefined();
      expect(updates$.subscribe).toBeDefined();
    });

    it('should emit INSERT event when new row is added', async () => {
      const updates$ = service.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(1), toArray()));
      
      // Simulate database sending a new row
      const row = { id: '1', name: 'test', value: 100 };
      service['processUpdate'](row, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      const events = await eventsPromise;
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'value']),
        row: row
      });
    });

    it('should emit UPDATE event with only changed fields', async () => {
      // First insert a row
      service['processUpdate']({ id: '1', name: 'original', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe after insert - will get snapshot (INSERT) then update
      const updates$ = service.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(2), toArray()));
      
      // Update with changed name
      service['processUpdate']({ id: '1', name: 'updated', value: 100 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      
      // First event is snapshot (INSERT)
      expect(events[0].type).toBe(RowUpdateType.Insert);
      
      // Second event is the UPDATE with only changed fields
      expect(events[1]).toEqual({
        type: RowUpdateType.Update,
        fields: new Set(['id', 'name']), // Only changed field + pk
        row: { id: '1', name: 'updated', value: 100 }
      });
    });

    it('should emit DELETE event with only primary key', async () => {
      // First insert a row
      const fullRow = { id: '1', name: 'test', value: 100, extra: 'data' };
      service['processUpdate'](fullRow, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe after insert - will get snapshot (INSERT) then delete
      const updates$ = service.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(2), toArray()));
      
      // Delete the row
      service['processUpdate'](fullRow, BigInt(2000), DatabaseRowUpdateType.Delete);
      
      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      
      // First event is snapshot (INSERT)
      expect(events[0].type).toBe(RowUpdateType.Insert);
      
      // Second event is the DELETE with only primary key
      expect(events[1].type).toBe(RowUpdateType.Delete);
      expect(events[1].fields).toEqual(new Set(['id']));
      expect(events[1].row).toEqual({ id: '1' });
    });

    it('should provide snapshot to new subscribers', async () => {
      // Insert some data before subscribing
      service['processUpdate']({ id: '1', name: 'first', value: 10 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      service['processUpdate']({ id: '2', name: 'second', value: 20 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      // New subscriber should get snapshot
      const updates$ = service.getUpdates();
      const events = await firstValueFrom(updates$.pipe(take(2), toArray()));
      
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(RowUpdateType.Insert);
      expect(events[0].row.id).toBe('1');
      expect(events[1].type).toBe(RowUpdateType.Insert);
      expect(events[1].row.id).toBe('2');
    });

    it('should handle multiple subscribers independently', async () => {
      // Insert initial data
      service['processUpdate']({ id: '1', name: 'initial', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // First subscriber
      const events1: RowUpdateEvent[] = [];
      const sub1 = service.getUpdates().subscribe(event => events1.push(event));
      
      // Second subscriber
      const events2: RowUpdateEvent[] = [];
      const sub2 = service.getUpdates().subscribe(event => events2.push(event));
      
      // Both should get snapshot
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      
      // New update
      service['processUpdate']({ id: '2', name: 'new', value: 200 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      await new Promise(resolve => setTimeout(resolve, 10));
      
      // Both should have received the new event
      expect(events1).toHaveLength(2);
      expect(events2).toHaveLength(2);
      
      sub1.unsubscribe();
      sub2.unsubscribe();
    });
  });

  describe('getPrimaryKeyField', () => {
    it('should return the primary key field name', () => {
      expect(service.getPrimaryKeyField()).toBe('id');
    });
  });

  describe('lifecycle', () => {
    it('should reject new subscriptions after shutdown', async () => {
      await service.onModuleDestroy();
      
      expect(() => service.getUpdates()).toThrow('shutting down');
    });
  });
});