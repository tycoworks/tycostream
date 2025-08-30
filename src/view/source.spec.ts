import { Source } from './source';
import type { SourceDefinition } from '../config/source.types';
import { DatabaseRowUpdateType } from '../database/types';
import { RowUpdateType, type RowUpdateEvent } from './types';
import { take, toArray } from 'rxjs/operators';
import { firstValueFrom } from 'rxjs';

// Mock DatabaseStream before importing StreamingService
const mockDatabaseStream = {
  connect: jest.fn().mockResolvedValue(undefined),
  disconnect: jest.fn(),
  streaming: false
};

jest.mock('../database/stream', () => {
  return {
    DatabaseStream: jest.fn().mockImplementation(() => mockDatabaseStream)
  };
});

describe('Source', () => {
  let source: Source;

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

  beforeEach(() => {
    // Reset mock database stream
    mockDatabaseStream.connect.mockClear();
    mockDatabaseStream.disconnect.mockClear();
    
    source = new Source(
      mockDatabaseStream as any,
      mockSourceDef,
      jest.fn()  // Required callback
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getUpdates', () => {
    it('should provide observable stream of row updates', () => {
      const updates$ = source.getUpdates();
      expect(updates$).toBeDefined();
      expect(updates$.subscribe).toBeDefined();
    });

    it('should emit INSERT event when new row is added', async () => {
      const updates$ = source.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(1), toArray()));
      
      // Simulate database sending a new row
      const row = { id: '1', name: 'test', value: 100 };
      source['processUpdate'](row, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
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
      source['processUpdate']({ id: '1', name: 'original', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe after insert - will get snapshot (INSERT) then update
      const updates$ = source.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(2), toArray()));
      
      // Update with changed name
      source['processUpdate']({ id: '1', name: 'updated', value: 100 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      
      // First event is snapshot (INSERT)
      expect(events[0].type).toBe(RowUpdateType.Insert);
      
      // Second event is the UPDATE with only changed fields
      expect(events[1]).toEqual({
        type: RowUpdateType.Update,
        fields: new Set(['name']), // Only actually changed fields
        row: { id: '1', name: 'updated', value: 100 }
      });
    });

    it('should enrich partial UPDATE with cached data', async () => {
      // First insert a complete row
      source['processUpdate']({ id: '1', name: 'original', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe after insert
      const updates$ = source.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(2), toArray()));
      
      // Send partial update (missing 'value' field - simulating what some DBs might send)
      source['processUpdate']({ id: '1', name: 'updated' }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      const events = await eventsPromise;
      
      // UPDATE event should have full row data despite partial input
      expect(events[1]).toEqual({
        type: RowUpdateType.Update,
        fields: new Set(['name']), // Only name actually changed
        row: { id: '1', name: 'updated', value: 100 } // Full row with enriched 'value'
      });
    });

    it('should emit DELETE event with full row data from cache', async () => {
      // First insert a row
      const fullRow = { id: '1', name: 'test', value: 100 };
      source['processUpdate'](fullRow, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe after insert - will get snapshot (INSERT) then delete
      const updates$ = source.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(2), toArray()));
      
      // Delete the row (database might only send primary key)
      const deleteRow = { id: '1' };
      source['processUpdate'](deleteRow, BigInt(2000), DatabaseRowUpdateType.Delete);
      
      const events = await eventsPromise;
      expect(events).toHaveLength(2);
      
      // First event is snapshot (INSERT)
      expect(events[0].type).toBe(RowUpdateType.Insert);
      
      // Second event is the DELETE with schema fields and enriched data
      expect(events[1].type).toBe(RowUpdateType.Delete);
      expect(events[1].fields).toEqual(new Set(['id', 'name', 'value']));
      expect(events[1].row).toEqual(fullRow);
    });

    it('should handle DELETE for uncached row', async () => {
      const updates$ = source.getUpdates();
      const eventsPromise = firstValueFrom(updates$.pipe(take(1), toArray()));
      
      // Delete a row that was never cached (edge case)
      const deleteRow = { id: '999' };
      source['processUpdate'](deleteRow, BigInt(1000), DatabaseRowUpdateType.Delete);
      
      const events = await eventsPromise;
      
      // Should still emit DELETE with whatever data we have
      expect(events[0]).toEqual({
        type: RowUpdateType.Delete,
        fields: new Set(['id', 'name', 'value']), // Schema fields
        row: { id: '999' } // Only has the data that was provided
      });
    });

    it('should provide snapshot to new subscribers', async () => {
      // Insert some data before subscribing
      source['processUpdate']({ id: '1', name: 'first', value: 10 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      source['processUpdate']({ id: '2', name: 'second', value: 20 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      // New subscriber should get snapshot
      const updates$ = source.getUpdates();
      const events = await firstValueFrom(updates$.pipe(take(2), toArray()));
      
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(RowUpdateType.Insert);
      expect(events[0].row.id).toBe('1');
      expect(events[1].type).toBe(RowUpdateType.Insert);
      expect(events[1].row.id).toBe('2');
    });

    it('should skip snapshot when skipSnapshot is true', async () => {
      // Insert some data before subscribing
      source['processUpdate']({ id: '1', name: 'first', value: 10 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      source['processUpdate']({ id: '2', name: 'second', value: 20 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
      // Subscribe with skipSnapshot
      const updates$ = source.getUpdates(true);
      
      // Add a new event after subscribing
      setTimeout(() => {
        source['processUpdate']({ id: '3', name: 'third', value: 30 }, BigInt(3000), DatabaseRowUpdateType.Upsert);
      }, 10);
      
      const events = await firstValueFrom(updates$.pipe(take(1), toArray()));
      
      // Should only get the new event, not the snapshot
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(RowUpdateType.Insert);
      expect(events[0].row.id).toBe('3');
    });

    it('should handle multiple subscribers independently', async () => {
      // Insert initial data
      source['processUpdate']({ id: '1', name: 'initial', value: 100 }, BigInt(1000), DatabaseRowUpdateType.Upsert);
      
      // First subscriber
      const events1: RowUpdateEvent[] = [];
      const sub1 = source.getUpdates().subscribe(event => events1.push(event));
      
      // Second subscriber
      const events2: RowUpdateEvent[] = [];
      const sub2 = source.getUpdates().subscribe(event => events2.push(event));
      
      // Both should get snapshot
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      
      // New update
      source['processUpdate']({ id: '2', name: 'new', value: 200 }, BigInt(2000), DatabaseRowUpdateType.Upsert);
      
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
      expect(source.getPrimaryKeyField()).toBe('id');
    });
  });


  describe('lifecycle', () => {
    it('should reject new subscriptions after shutdown', () => {
      source.dispose();
      
      expect(() => source.getUpdates()).toThrow('shutting down');
    });

    it('should call disposal callback when disposed', async () => {
      const onDispose = jest.fn();
      const sourceWithCallback = new Source(
        mockDatabaseStream as any,
        mockSourceDef,
        onDispose
      );
      
      // Trigger disposal
      sourceWithCallback.dispose();
      
      expect(onDispose).toHaveBeenCalled();
      expect(mockDatabaseStream.disconnect).toHaveBeenCalled();
    });
  });
});