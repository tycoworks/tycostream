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
      expect(result!.fields).toEqual(new Set(['id', 'active'])); // Keeps original UPDATE fields
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
      expect(result!.fields).toEqual(new Set(['id', 'active'])); // Keeps original UPDATE fields
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

      it('should handle overlapping conditions with match precedence', () => {
        // Test the case where both match and unmatch can be true
        // Match should take precedence to prevent oscillation
        const filter = new Filter(
          {
            evaluate: (row) => row.score > 100,
            fields: new Set(['score']),
            expression: 'score > 100'
          },
          {
            evaluate: (row) => row.active === false,
            fields: new Set(['active']),
            expression: 'active === false'
          }
        );

        const view = new View(mockSource, filter);

        // Case 1: Both conditions true in single update from outside view
        const enter = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'score', 'active']),
          row: { id: 1, score: 150, active: false }
        });
        expect(enter).not.toBeNull();
        expect(enter!.type).toBe(RowUpdateType.Insert); // Should enter due to match precedence

        // Case 2: Unmatch becomes true while match stays true (row in view)
        const stay = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'active']),
          row: { id: 1, score: 150, active: true } // First set active to true
        });
        expect(stay).not.toBeNull();
        
        const stillStay = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'active']),
          row: { id: 1, score: 150, active: false } // Now set active to false
        });
        expect(stillStay).not.toBeNull();
        expect(stillStay!.type).toBe(RowUpdateType.Update); // Should stay due to match precedence

        // Case 3: Only leaves when match becomes false AND unmatch is true
        const exit = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'score']),
          row: { id: 1, score: 50, active: false }
        });
        expect(exit).not.toBeNull();
        expect(exit!.type).toBe(RowUpdateType.Delete); // Now it leaves
      });

      it('should not change view membership when irrelevant fields update', () => {
        const filter = new Filter(
          {
            evaluate: (row) => row.active === true,
            fields: new Set(['active']),
            expression: 'active === true'
          },
          {
            evaluate: (row) => row.priority < 5,
            fields: new Set(['priority']),
            expression: 'priority < 5'
          }
        );

        const view = new View(mockSource, filter);

        // Row enters view (active=true, priority=10)
        const enter = view.processEvent({
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'active', 'priority', 'name']),
          row: { id: 1, active: true, priority: 10, name: 'Test' }
        });
        expect(enter).not.toBeNull();
        expect(enter!.type).toBe(RowUpdateType.Insert);

        // Update irrelevant field (name) - row should stay in view
        const stay1 = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'name']),
          row: { id: 1, active: true, priority: 10, name: 'Updated' }
        });
        expect(stay1).not.toBeNull();
        expect(stay1!.type).toBe(RowUpdateType.Update);

        // Update another irrelevant field (description) - row should still stay
        const stay2 = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'description']),
          row: { id: 1, active: true, priority: 10, name: 'Updated', description: 'New' }
        });
        expect(stay2).not.toBeNull();
        expect(stay2!.type).toBe(RowUpdateType.Update);

        // Update relevant field but stay in hysteresis zone (active=false, priority=10)
        // Should stay because match=false but unmatch=false too
        const stay3 = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'active']),
          row: { id: 1, active: false, priority: 10, name: 'Updated', description: 'New' }
        });
        expect(stay3).not.toBeNull();
        expect(stay3!.type).toBe(RowUpdateType.Update);
        
        // Now update priority to trigger unmatch and cause exit
        const exit = view.processEvent({
          type: RowUpdateType.Update,
          fields: new Set(['id', 'priority']),
          row: { id: 1, active: false, priority: 3, name: 'Updated', description: 'New' }
        });
        expect(exit).not.toBeNull();
        expect(exit!.type).toBe(RowUpdateType.Delete);
      });
    });
  });
  
  describe('deltaUpdates mode', () => {
    it('should return only primary key for DELETE events', () => {
      const view = new View(mockSource, undefined, true); // deltaUpdates = true
      
      // First insert a row to track it
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'value']),
        row: { id: 1, name: 'Test', value: 100 }
      });
      
      // Then delete it
      const deleteEvent: RowUpdateEvent = {
        type: RowUpdateType.Delete,
        fields: new Set(['id', 'name', 'value']),
        row: { id: 1, name: 'Test', value: 100 }
      };
      
      const result = view.processEvent(deleteEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(RowUpdateType.Delete);
      expect(result!.row).toEqual({ id: 1 }); // Only primary key
      expect(result!.fields).toEqual(new Set(['id', 'name', 'value'])); // Original fields preserved
    });
    
    it('should return primary key + changed fields for UPDATE events', () => {
      const view = new View(mockSource, undefined, true); // deltaUpdates = true
      
      // First insert a row
      view.processEvent({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'value']),
        row: { id: 1, name: 'Test', value: 100 }
      });
      
      // Then update it
      const updateEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['value']), // Only value changed
        row: { id: 1, name: 'Test', value: 200 }
      };
      
      const result = view.processEvent(updateEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(RowUpdateType.Update);
      expect(result!.row).toEqual({ id: 1, value: 200 }); // PK + changed field
      expect(result!.fields).toEqual(new Set(['value']));
    });
    
    it('should return full row for INSERT events', () => {
      const view = new View(mockSource, undefined, true); // deltaUpdates = true
      
      const insertEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'value']),
        row: { id: 1, name: 'Test', value: 100 }
      };
      
      const result = view.processEvent(insertEvent);
      expect(result).not.toBeNull();
      expect(result!.type).toBe(RowUpdateType.Insert);
      expect(result!.row).toEqual({ id: 1, name: 'Test', value: 100 }); // Full row
      expect(result!.fields).toEqual(new Set(['id', 'name', 'value']));
    });
    
    it('should work with filters in deltaUpdates mode', () => {
      const filter = new Filter({
        evaluate: (row) => row.value > 50,
        fields: new Set(['value']),
        expression: 'value > 50'
      });
      
      const view = new View(mockSource, filter, true); // deltaUpdates = true
      
      // Row enters view
      const enterEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['value']),
        row: { id: 1, name: 'Test', value: 100 }
      };
      
      const enterResult = view.processEvent(enterEvent);
      expect(enterResult).not.toBeNull();
      expect(enterResult!.type).toBe(RowUpdateType.Insert); // Transformed to INSERT
      expect(enterResult!.row).toEqual({ id: 1, name: 'Test', value: 100 }); // Full row for INSERT
      
      // Update within view
      const updateEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['name']),
        row: { id: 1, name: 'Updated', value: 100 }
      };
      
      const updateResult = view.processEvent(updateEvent);
      expect(updateResult).not.toBeNull();
      expect(updateResult!.type).toBe(RowUpdateType.Update);
      expect(updateResult!.row).toEqual({ id: 1, name: 'Updated' }); // PK + changed field
      
      // Row leaves view
      const leaveEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['value']),
        row: { id: 1, name: 'Updated', value: 25 }
      };
      
      const leaveResult = view.processEvent(leaveEvent);
      expect(leaveResult).not.toBeNull();
      expect(leaveResult!.type).toBe(RowUpdateType.Delete); // Transformed to DELETE
      expect(leaveResult!.row).toEqual({ id: 1 }); // Only PK for DELETE
    });
    
    it('should handle DELETE events correctly with filters', () => {
      const filter = new Filter({
        evaluate: (row) => row.active === true,
        fields: new Set(['active']),
        expression: 'active === true'
      });
      
      const view = new View(mockSource, filter);
      
      // Insert a row that passes the filter (enters view)
      const insertEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'User1', active: true }
      };
      
      const insertResult = view.processEvent(insertEvent);
      expect(insertResult).not.toBeNull();
      expect(insertResult!.type).toBe(RowUpdateType.Insert);
      
      // Delete the row that's in view - should pass through
      const deleteInViewEvent: RowUpdateEvent = {
        type: RowUpdateType.Delete,
        fields: new Set(['id']),
        row: { id: 1, name: 'User1', active: true }
      };
      
      const deleteInViewResult = view.processEvent(deleteInViewEvent);
      expect(deleteInViewResult).not.toBeNull();
      expect(deleteInViewResult!.type).toBe(RowUpdateType.Delete);
      
      // Insert another row that doesn't pass filter (never enters view)
      const insertOutEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 2, name: 'User2', active: false }
      };
      
      const insertOutResult = view.processEvent(insertOutEvent);
      expect(insertOutResult).toBeNull(); // Filtered out
      
      // Delete a row that was never in view - should be filtered out
      const deleteOutViewEvent: RowUpdateEvent = {
        type: RowUpdateType.Delete,
        fields: new Set(['id']),
        row: { id: 2, name: 'User2', active: false }
      };
      
      const deleteOutViewResult = view.processEvent(deleteOutViewEvent);
      expect(deleteOutViewResult).toBeNull(); // Filtered out since it wasn't in view
      
      // Edge case: Row enters view, leaves view, then gets deleted
      const enterEvent: RowUpdateEvent = {
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 3, name: 'User3', active: true }
      };
      view.processEvent(enterEvent); // Row enters view
      
      const leaveEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['active']),
        row: { id: 3, name: 'User3', active: false }
      };
      view.processEvent(leaveEvent); // Row leaves view
      
      const deleteAfterLeaveEvent: RowUpdateEvent = {
        type: RowUpdateType.Delete,
        fields: new Set(['id']),
        row: { id: 3, name: 'User3', active: false }
      };
      
      const deleteAfterLeaveResult = view.processEvent(deleteAfterLeaveEvent);
      expect(deleteAfterLeaveResult).toBeNull(); // Not in view, so filtered out
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