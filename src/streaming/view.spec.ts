import { View } from './view';
import { RowUpdateEvent, RowUpdateType, Filter } from './types';

describe('View', () => {
  describe('getSnapshot', () => {
    it('should return all rows when no filter is provided', () => {
      const view = new View(null, 'id');
      const rows = [
        { id: 1, name: 'Test1' },
        { id: 2, name: 'Test2' }
      ];
      
      const snapshot = view.getSnapshot(rows);
      expect(snapshot).toEqual(rows);
    });
    
    it('should filter rows based on filter expression', () => {
      const filter: Filter = {
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, 'id');
      const rows = [
        { id: 1, name: 'Test1', active: true },
        { id: 2, name: 'Test2', active: false },
        { id: 3, name: 'Test3', active: true }
      ];
      
      const snapshot = view.getSnapshot(rows);
      expect(snapshot).toHaveLength(2);
      expect(snapshot).toEqual([
        { id: 1, name: 'Test1', active: true },
        { id: 3, name: 'Test3', active: true }
      ]);
    });
    
    it('should use cached visibility on subsequent calls', () => {
      const evaluateMock = jest.fn((row) => row.active === true);
      const filter: Filter = {
        evaluate: evaluateMock,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      };
      
      const view = new View(filter, 'id');
      const rows = [
        { id: 1, name: 'Test1', active: true },
        { id: 2, name: 'Test2', active: false }
      ];
      
      // First call should evaluate filter
      view.getSnapshot(rows);
      expect(evaluateMock).toHaveBeenCalledTimes(2);
      
      // Second call should use cached visibility
      evaluateMock.mockClear();
      view.getSnapshot(rows);
      expect(evaluateMock).not.toHaveBeenCalled();
    });
  });
  
  describe('processEvent', () => {
    it('should pass through events when no filter is provided', () => {
      const view = new View(null, 'id');
      
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
      
      const view = new View(filter, 'id');
      
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
      
      const view = new View(filter, 'id');
      
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
      
      const view = new View(filter, 'id');
      
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
      
      const view = new View(filter, 'id');
      
      const event: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: false }
      };
      
      const result = view.processEvent(event);
      expect(result).toBeNull();
    });
    
    it('should handle DELETE events correctly', () => {
      const view = new View(null, 'id');
      
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
      
      const view = new View(filter, 'id');
      
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
  
  describe('dispose', () => {
    it('should clear visible keys', () => {
      const view = new View(null, 'id');
      
      // Add some rows
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Test' }
      });
      
      view.dispose();
      
      // After dispose, processing same row should treat it as new
      const result = view.processEvent({
        type: RowUpdateType.Update,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Test2' }
      });
      
      // Should be INSERT since visibleKeys was cleared
      expect(result!.type).toBe(RowUpdateType.Insert);
    });
  });
});