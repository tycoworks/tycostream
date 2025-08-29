import { StateTracker, StateTransition } from './states';
import { RowUpdateEvent, RowUpdateType, Expression } from '../streaming/types';

describe('StateTracker', () => {
  let tracker: StateTracker;
  const primaryKeyField = 'id';
  
  const createEvent = (id: number, row: any, type = RowUpdateType.Insert): RowUpdateEvent => ({
    type,
    fields: new Set(Object.keys(row)),
    row: { id, ...row }
  });

  describe('basic state transitions', () => {
    beforeEach(() => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      tracker = new StateTracker(primaryKeyField, match);
    });

    it('should return Match when row enters matched state', () => {
      const event = createEvent(1, { value: 150 });
      const transition = tracker.processEvent(event);
      expect(transition).toBe(StateTransition.Match);
    });

    it('should return Unmatched when row does not match on insert', () => {
      const event = createEvent(1, { value: 50 });
      const transition = tracker.processEvent(event);
      expect(transition).toBe(StateTransition.Unmatched);
    });

    it('should return Matched when row stays in matched state', () => {
      // First enter matched state
      tracker.processEvent(createEvent(1, { value: 150 }));
      
      // Update with still matching value
      const updateEvent = createEvent(1, { value: 200, name: 'updated' }, RowUpdateType.Update);
      const transition = tracker.processEvent(updateEvent);
      expect(transition).toBe(StateTransition.Matched);
    });

    it('should return Unmatch when row leaves matched state', () => {
      // First enter matched state
      tracker.processEvent(createEvent(1, { value: 150 }));
      
      // Update with non-matching value
      const updateEvent = createEvent(1, { value: 50 }, RowUpdateType.Update);
      const transition = tracker.processEvent(updateEvent);
      expect(transition).toBe(StateTransition.Unmatch);
    });

    it('should handle DELETE events correctly', () => {
      // Row was matched
      tracker.processEvent(createEvent(1, { value: 150 }));
      const deleteEvent = createEvent(1, { value: 150 }, RowUpdateType.Delete);
      expect(tracker.processEvent(deleteEvent)).toBe(StateTransition.Unmatch);
      
      // Row was not matched
      const deleteEvent2 = createEvent(2, { value: 50 }, RowUpdateType.Delete);
      expect(tracker.processEvent(deleteEvent2)).toBe(StateTransition.Unmatched);
    });
  });

  describe('unmatch negation', () => {
    it('should automatically create unmatch as negation when not provided', () => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      
      tracker = new StateTracker(primaryKeyField, match);
      
      // Enter matched state
      tracker.processEvent(createEvent(1, { value: 150 }));
      
      // Value still > 100, so !unmatch is true (should stay)
      const update1 = createEvent(1, { value: 120 }, RowUpdateType.Update);
      expect(tracker.processEvent(update1)).toBe(StateTransition.Matched);
      
      // Value <= 100, so !unmatch is false (should exit)
      const update2 = createEvent(1, { value: 100 }, RowUpdateType.Update);
      expect(tracker.processEvent(update2)).toBe(StateTransition.Unmatch);
    });

    it('should use provided unmatch expression', () => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      
      const unmatch: Expression = {
        expression: 'value <= 90',
        fields: new Set(['value']),
        evaluate: (row) => row.value <= 90
      };
      
      tracker = new StateTracker(primaryKeyField, match, unmatch);
      
      // Enter matched state
      tracker.processEvent(createEvent(1, { value: 150 }));
      
      // Value = 95 (not <= 90), so !unmatch is true (should stay)
      const update1 = createEvent(1, { value: 95 }, RowUpdateType.Update);
      expect(tracker.processEvent(update1)).toBe(StateTransition.Matched);
      
      // Value = 90, so unmatch is true, !unmatch is false (should exit)
      const update2 = createEvent(1, { value: 90 }, RowUpdateType.Update);
      expect(tracker.processEvent(update2)).toBe(StateTransition.Unmatch);
    });
  });

  describe('hysteresis behavior', () => {
    beforeEach(() => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      
      const unmatch: Expression = {
        expression: 'value <= 90',
        fields: new Set(['value']),
        evaluate: (row) => row.value <= 90
      };
      
      tracker = new StateTracker(primaryKeyField, match, unmatch);
    });

    it('should handle hysteresis with different thresholds', () => {
      // Start with value = 80 (unmatched)
      const event1 = createEvent(1, { value: 80 });
      expect(tracker.processEvent(event1)).toBe(StateTransition.Unmatched);
      
      // Cross match threshold (> 100)
      const event2 = createEvent(1, { value: 110 }, RowUpdateType.Update);
      expect(tracker.processEvent(event2)).toBe(StateTransition.Match);
      
      // In hysteresis zone (90 < value <= 100) - should stay matched
      const event3 = createEvent(1, { value: 95 }, RowUpdateType.Update);
      expect(tracker.processEvent(event3)).toBe(StateTransition.Matched);
      
      // Cross unmatch threshold (<= 90)
      const event4 = createEvent(1, { value: 90 }, RowUpdateType.Update);
      expect(tracker.processEvent(event4)).toBe(StateTransition.Unmatch);
      
      // Back in hysteresis zone - should stay unmatched
      const event5 = createEvent(1, { value: 95 }, RowUpdateType.Update);
      expect(tracker.processEvent(event5)).toBe(StateTransition.Unmatched);
      
      // Must cross match threshold again to re-enter
      const event6 = createEvent(1, { value: 101 }, RowUpdateType.Update);
      expect(tracker.processEvent(event6)).toBe(StateTransition.Match);
    });
  });

  describe('field change optimization', () => {
    beforeEach(() => {
      const match: Expression = {
        expression: 'status === "active"',
        fields: new Set(['status']),
        evaluate: (row) => row.status === 'active'
      };
      
      const unmatch: Expression = {
        expression: 'status === "deleted"',
        fields: new Set(['status']),
        evaluate: (row) => row.status === 'deleted'
      };
      
      tracker = new StateTracker(primaryKeyField, match, unmatch);
    });

    it('should skip evaluation when filter fields have not changed', () => {
      // Enter matched state
      tracker.processEvent(createEvent(1, { status: 'active', name: 'test' }));
      
      // Update non-filter field - should stay matched without re-evaluation
      const updateEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['name']), // Only name changed, not status
        row: { id: 1, status: 'active', name: 'updated' }
      };
      
      const transition = tracker.processEvent(updateEvent);
      expect(transition).toBe(StateTransition.Matched);
    });

    it('should re-evaluate when filter fields change', () => {
      // Enter matched state
      tracker.processEvent(createEvent(1, { status: 'active', name: 'test' }));
      
      // Update filter field
      const updateEvent: RowUpdateEvent = {
        type: RowUpdateType.Update,
        fields: new Set(['status']), // Status changed
        row: { id: 1, status: 'deleted', name: 'test' }
      };
      
      const transition = tracker.processEvent(updateEvent);
      expect(transition).toBe(StateTransition.Unmatch);
    });
  });

  describe('error handling', () => {
    it('should return false for match when evaluation throws', () => {
      const match: Expression = {
        expression: 'will.throw.error',
        fields: new Set(['will']),
        evaluate: () => { throw new Error('Evaluation error'); }
      };
      
      tracker = new StateTracker(primaryKeyField, match);
      
      const event = createEvent(1, { value: 100 });
      const transition = tracker.processEvent(event);
      
      // Should treat error as non-match
      expect(transition).toBe(StateTransition.Unmatched);
    });
  });

  describe('multiple rows', () => {
    beforeEach(() => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      tracker = new StateTracker(primaryKeyField, match);
    });

    it('should track state independently for different rows', () => {
      // Row 1 enters matched
      expect(tracker.processEvent(createEvent(1, { value: 150 }))).toBe(StateTransition.Match);
      
      // Row 2 enters unmatched
      expect(tracker.processEvent(createEvent(2, { value: 50 }))).toBe(StateTransition.Unmatched);
      
      // Row 1 stays matched
      expect(tracker.processEvent(createEvent(1, { value: 120 }, RowUpdateType.Update))).toBe(StateTransition.Matched);
      
      // Row 2 enters matched
      expect(tracker.processEvent(createEvent(2, { value: 110 }, RowUpdateType.Update))).toBe(StateTransition.Match);
    });
  });

  describe('dispose', () => {
    it('should clear matched keys on dispose', () => {
      const match: Expression = {
        expression: 'value > 100',
        fields: new Set(['value']),
        evaluate: (row) => row.value > 100
      };
      tracker = new StateTracker(primaryKeyField, match);
      
      // Add some matched rows
      tracker.processEvent(createEvent(1, { value: 150 }));
      tracker.processEvent(createEvent(2, { value: 200 }));
      
      // Dispose
      tracker.dispose();
      
      // After dispose, same rows should be treated as new
      expect(tracker.processEvent(createEvent(1, { value: 150 }))).toBe(StateTransition.Match);
    });
  });
});