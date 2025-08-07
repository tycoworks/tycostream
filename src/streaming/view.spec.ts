import { View } from './view';
import { RowUpdateEvent, RowUpdateType, Filter } from './types';
import { Subject, Observable } from 'rxjs';
import type { Source } from './source';

// Empty filter that matches all rows
const EMPTY_FILTER: Filter = {
  expression: '',
  fields: new Set<string>(),
  evaluate: () => true
};

describe('View', () => {
  let mockSource: jest.Mocked<Source>;
  let mockUpdates$: Subject<RowUpdateEvent>;
  
  beforeEach(() => {
    mockUpdates$ = new Subject<RowUpdateEvent>();
    
    mockSource = {
      getPrimaryKeyField: jest.fn().mockReturnValue('id'),
      getUpdates: jest.fn().mockReturnValue(mockUpdates$),
      onModuleDestroy: jest.fn()
    } as any;
  });
  describe('processEvent', () => {
    it('should pass through events when empty filter is provided', () => {
      const view = new View(EMPTY_FILTER, mockSource);
      
      const insertEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Test' }
      };
      
      const result = view.processEvent(insertEvent);
      expect(result).toEqual(insertEvent);
    });
    
    it('should handle row entering view', () => {
      const filter: Filter = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, mockSource);
      
      const event: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['id', 'active']),
        row: { id: 1, name: 'Test', active: true }
      };
      
      const result = view.processEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(RowUpdateType.Insert);
      expect(result!.fields).toEqual(new Set(['id', 'name', 'active']));
    });
    
    it('should handle row leaving view', () => {
      const filter: Filter = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, mockSource);
      
      // First, add row to view
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: true }
      });
      
      // Then update to make it leave
      const event: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['id', 'active']),
        row: { id: 1, name: 'Test', active: false }
      };
      
      const result = view.processEvent(event);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(RowUpdateType.Delete);
      expect(result!.fields).toEqual(new Set(['id']));
    });
    
    it('should handle row updating within view', () => {
      const filter: Filter = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, mockSource);
      
      // First, add row to view
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: true }
      });
      
      // Update name only (not affecting filter)
      const event: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Updated', active: true }
      };
      
      const result = view.processEvent(event);
      expect(result).toEqual(event);
    });
    
    it('should filter out rows not matching filter', () => {
      const filter: Filter = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, mockSource);
      
      const event: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: false }
      };
      
      const result = view.processEvent(event);
      expect(result).toBeNull();
    });
    
    it('should handle DELETE events correctly', () => {
      const view = new View(EMPTY_FILTER, mockSource);
      
      // First insert a row
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Test' }
      });
      
      // Then delete it
      const deleteEvent: RowUpdateEvent = {
        type: RowUpdateType.Delete,
        fields: new Set(['id']),
        row: { id: 1 }
      };
      
      const result = view.processEvent(deleteEvent);
      expect(result).toEqual(deleteEvent);
    });
    
    it('should skip filter evaluation for UPDATE when fields dont affect filter', () => {
      const evaluateMock = jest.fn((row) => row.active === true);
      const filter: Filter = {
        evaluate: evaluateMock,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, mockSource);
      
      // First insert to establish visibility
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: true }
      });
      
      evaluateMock.mockClear();
      
      // Update that doesn't affect filter fields
      const event: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Updated', active: true }
      };
      
      view.processEvent(event);
      
      // Should not re-evaluate filter
      expect(evaluateMock).not.toHaveBeenCalled();
    });
  });
  
  describe('getUpdates', () => {
    it('should emit transformed events that pass the filter', (done) => {
      const filter: Filter = {
        expression: 'value > 10',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 10
      };
      const view = new View(filter, mockSource);
      
      // Subscribe to the view's updates
      const receivedEvents: RowUpdateEvent[] = [];
      view.getUpdates().subscribe(event => {
        receivedEvents.push(event);
      });
      
      // Emit an event that passes the filter
      const passingEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'value']),
        row: { id: 1, value: 20 }
      };
      mockUpdates$.next(passingEvent);
      
      // Emit an event that fails the filter
      const failingEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'value']),
        row: { id: 2, value: 5 }
      };
      mockUpdates$.next(failingEvent);
      
      // Give time for async operations
      setTimeout(() => {
        expect(receivedEvents).toHaveLength(1);
        expect(receivedEvents[0]).toEqual(passingEvent);
        done();
      }, 10);
    });
    
  });
  
});