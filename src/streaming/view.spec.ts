import { View } from './view';
import { Filter } from './filter';
import { RowUpdateEvent, RowUpdateType } from './types';
import { Subject, Observable } from 'rxjs';
import type { Source } from './source';

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
    it('should pass through events when no filter is provided', () => {
      const view = new View(mockSource);
      
      const insertEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Test' }
      };
      
      const result = view.processEvent(insertEvent);
      expect(result).toEqual(insertEvent);
    });
    
    it('should handle row entering view', () => {
      const filter = new Filter({
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      });
      
      const view = new View(mockSource, filter);
      
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
      const filter = new Filter({
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      });
      
      const view = new View(mockSource, filter);
      
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
      const filter = new Filter({
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      });
      
      const view = new View(mockSource, filter);
      
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
      const filter = new Filter({
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      });
      
      const view = new View(mockSource, filter);
      
      const event: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Test', active: false }
      };
      
      const result = view.processEvent(event);
      expect(result).toBeNull();
    });
    
    it('should handle DELETE events correctly', () => {
      const view = new View(mockSource);
      
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
      const filter = new Filter({
        evaluate: evaluateMock,
        fields: new Set(['active']),
        expression: 'datum.active === true'
      });
      
      const view = new View(mockSource, filter);
      
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

    describe('asymmetric match/unmatch conditions', () => {
      it('should handle hysteresis with different match and unmatch thresholds', () => {
        const filter = new Filter(
          {
            evaluate: (row) => row.value >= 100,
            fields: new Set(['value']),
            expression: 'value >= 100'
          },
          {
            evaluate: (row) => row.value < 95,
            fields: new Set(['value']),
            expression: 'value < 95'
          }
        );

        const view = new View(mockSource, filter);

        // Row enters at 100
        const enter = view.processEvent({
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'value']),
          row: { id: 1, value: 100 }
        });
        expect(enter).not.toBeNull();
        expect(enter!.type).toBe(RowUpdateType.Insert);

        // Row stays in view at 97 (between thresholds)
        const stay = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'value']),
          row: { id: 1, value: 97 }
        });
        expect(stay).not.toBeNull();
        expect(stay!.type).toBe(RowUpdateType.Update);

        // Row exits at 94
        const exit = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'value']),
          row: { id: 1, value: 94 }
        });
        expect(exit).not.toBeNull();
        expect(exit!.type).toBe(RowUpdateType.Delete);
      });

      it('should not re-enter view until match condition is met again', () => {
        const filter = new Filter(
          {
            evaluate: (row) => row.price > 10000,
            fields: new Set(['price']),
            expression: 'price > 10000'
          },
          {
            evaluate: (row) => row.price <= 9500,
            fields: new Set(['price']),
            expression: 'price <= 9500'
          }
        );

        const view = new View(mockSource, filter);

        // Enter view at 10001
        view.processEvent({
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'price']),
          row: { id: 1, price: 10001 }
        });

        // Exit view at 9500
        view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'price']),
          row: { id: 1, price: 9500 }
        });

        // Should not re-enter at 9600 (below match threshold)
        const noReenter = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'price']),
          row: { id: 1, price: 9600 }
        });
        expect(noReenter).toBeNull();

        // Should re-enter at 10001
        const reenter = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'price']),
          row: { id: 1, price: 10001 }
        });
        expect(reenter).not.toBeNull();
        expect(reenter!.type).toBe(RowUpdateType.Insert);
      });

      it('should handle unmatch condition using different fields than match', () => {
        const filter = new Filter(
          {
            evaluate: (row) => row.status === 'active',
            fields: new Set(['status']),
            expression: 'status === "active"'
          },
          {
            evaluate: (row) => row.terminated === true,
            fields: new Set(['terminated']),
            expression: 'terminated === true'
          }
        );

        const view = new View(mockSource, filter);

        // Enter view with active status
        const enter = view.processEvent({
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'status', 'terminated']),
          row: { id: 1, status: 'active', terminated: false }
        });
        expect(enter).not.toBeNull();

        // Stay in view when status changes but terminated is still false
        const stay = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'status']),
          row: { id: 1, status: 'inactive', terminated: false }
        });
        expect(stay).not.toBeNull();
        expect(stay!.type).toBe(RowUpdateType.Update);

        // Exit when terminated becomes true
        const exit = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'terminated']),
          row: { id: 1, status: 'inactive', terminated: true }
        });
        expect(exit).not.toBeNull();
        expect(exit!.type).toBe(RowUpdateType.Delete);
      });

      it('should correctly identify relevant fields for optimization', () => {
        const matchEvaluate = jest.fn((row) => row.active === true);
        const unmatchEvaluate = jest.fn((row) => row.priority < 5);
        
        const filter = new Filter(
          {
            evaluate: matchEvaluate,
            fields: new Set(['active']),
            expression: 'active === true'
          },
          {
            evaluate: unmatchEvaluate,
            fields: new Set(['priority']),
            expression: 'priority < 5'
          }
        );

        const view = new View(mockSource, filter);

        // Enter view
        view.processEvent({
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'active', 'priority', 'name']),
          row: { id: 1, active: true, priority: 10, name: 'Test' }
        });

        matchEvaluate.mockClear();
        unmatchEvaluate.mockClear();

        // Update unrelated field - should skip evaluation
        view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'name']),
          row: { id: 1, active: true, priority: 10, name: 'Updated' }
        });

        expect(matchEvaluate).not.toHaveBeenCalled();
        expect(unmatchEvaluate).not.toHaveBeenCalled();

        // Update relevant field - should evaluate
        view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'priority']),
          row: { id: 1, active: true, priority: 3, name: 'Updated' }
        });

        expect(unmatchEvaluate).toHaveBeenCalled();
      });
    });
  });
  
  describe('getUpdates', () => {
    it('should emit transformed events that pass the filter', (done) => {
      const filter = new Filter({
        expression: 'value > 10',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 10
      });
      const view = new View(mockSource, filter);
      
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