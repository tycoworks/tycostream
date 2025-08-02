import { of, Subject } from 'rxjs';
import { View } from './view';
import { RowUpdateEvent, RowUpdateType, Filter } from './types';

describe('View', () => {
  let source$: Subject<RowUpdateEvent>;
  let cache: Map<string | number, any>;
  let getRow: (key: string | number) => any | undefined;
  
  beforeEach(() => {
    source$ = new Subject<RowUpdateEvent>();
    cache = new Map();
    getRow = (key: string | number) => cache.get(key);
  });
  
  afterEach(() => {
    source$.complete();
  });
  
  describe('without filter', () => {
    it('should pass through all events when no filter is provided', (done) => {
      const view = new View(source$, null, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(3);
          expect(events[0].type).toBe(RowUpdateType.Insert);
          expect(events[1].type).toBe(RowUpdateType.Update);
          expect(events[2].type).toBe(RowUpdateType.Delete);
          done();
        }
      });
      
      // Simulate events
      cache.set(1, { id: 1, name: 'Test' });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, name: 'Test' } });
      
      cache.set(1, { id: 1, name: 'Updated' });
      source$.next({ type: RowUpdateType.Update, row: { id: 1, name: 'Updated' } });
      
      source$.next({ type: RowUpdateType.Delete, row: { id: 1 } });
      
      source$.complete();
    });
  });
  
  describe('with filter', () => {
    it('should only emit INSERT when row enters the view', (done) => {
      const filter: Filter = {
        evaluate: (row) => row.status === 'active',
        fields: new Set(['status']),
        expression: 'datum.status === "active"'
      };
      
      const view = new View(source$, filter, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(1);
          expect(events[0].type).toBe(RowUpdateType.Insert);
          expect(events[0].row).toEqual({ id: 1, status: 'active' });
          done();
        }
      });
      
      // Row doesn't match filter initially
      cache.set(1, { id: 1, status: 'inactive' });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, status: 'inactive' } });
      
      // Row updated to match filter - should generate INSERT
      cache.set(1, { id: 1, status: 'active' });
      source$.next({ type: RowUpdateType.Update, row: { id: 1, status: 'active' } });
      
      source$.complete();
    });
    
    it('should emit DELETE when row leaves the view', (done) => {
      const filter: Filter = {
        evaluate: (row) => row.status === 'active',
        fields: new Set(['status']),
        expression: 'datum.status === "active"'
      };
      
      const view = new View(source$, filter, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(2);
          expect(events[0].type).toBe(RowUpdateType.Insert);
          expect(events[1].type).toBe(RowUpdateType.Delete);
          expect(events[1].row).toEqual({ id: 1 }); // DELETE only has key
          done();
        }
      });
      
      // Row matches filter initially
      cache.set(1, { id: 1, status: 'active' });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, status: 'active' } });
      
      // Row updated to not match filter - should generate DELETE
      cache.set(1, { id: 1, status: 'inactive' });
      source$.next({ type: RowUpdateType.Update, row: { id: 1, status: 'inactive' } });
      
      source$.complete();
    });
    
    it('should pass through UPDATE when row stays in view', (done) => {
      const filter: Filter = {
        evaluate: (row) => row.age >= 18,
        fields: new Set(['age']),
        expression: 'datum.age >= 18'
      };
      
      const view = new View(source$, filter, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(2);
          expect(events[0].type).toBe(RowUpdateType.Insert);
          expect(events[1].type).toBe(RowUpdateType.Update);
          expect(events[1].row).toEqual({ id: 1, name: 'Updated' }); // Only changed fields
          done();
        }
      });
      
      // Row matches filter
      cache.set(1, { id: 1, name: 'Test', age: 25 });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, name: 'Test', age: 25 } });
      
      // Update doesn't affect filter match
      cache.set(1, { id: 1, name: 'Updated', age: 25 });
      source$.next({ type: RowUpdateType.Update, row: { id: 1, name: 'Updated' } });
      
      source$.complete();
    });
    
    it('should ignore events for rows not in view', (done) => {
      const filter: Filter = {
        evaluate: (row) => row.visible === true,
        fields: new Set(['visible']),
        expression: 'datum.visible === true'
      };
      
      const view = new View(source$, filter, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(0);
          done();
        }
      });
      
      // Row doesn't match filter
      cache.set(1, { id: 1, visible: false });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, visible: false } });
      
      // Update still doesn't match
      cache.set(1, { id: 1, visible: false, name: 'Updated' });
      source$.next({ type: RowUpdateType.Update, row: { id: 1, name: 'Updated' } });
      
      // Delete of non-visible row
      source$.next({ type: RowUpdateType.Delete, row: { id: 1 } });
      
      source$.complete();
    });
    
    it('should handle filter evaluation errors gracefully', (done) => {
      const filter: Filter = {
        evaluate: (row) => {
          if (row.id === 2) {
            throw new Error('Filter error');
          }
          return true;
        },
        fields: new Set(),
        expression: 'custom filter'
      };
      
      const view = new View(source$, filter, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(1);
          expect(events[0].row.id).toBe(1);
          done();
        }
      });
      
      // This should work
      cache.set(1, { id: 1 });
      source$.next({ type: RowUpdateType.Insert, row: { id: 1 } });
      
      // This should fail filter evaluation and be excluded
      cache.set(2, { id: 2 });
      source$.next({ type: RowUpdateType.Insert, row: { id: 2 } });
      
      source$.complete();
    });
  });
  
  describe('edge cases', () => {
    it('should handle INSERT events as full row', (done) => {
      // For INSERT events, we should use the event row, not cache
      const view = new View(source$, null, 'id', getRow);
      const events: RowUpdateEvent[] = [];
      
      view.getUpdates().subscribe({
        next: (event) => events.push(event),
        complete: () => {
          expect(events).toHaveLength(1);
          expect(events[0].type).toBe(RowUpdateType.Insert);
          expect(events[0].row).toEqual({ id: 1, name: 'Test' });
          done();
        }
      });
      
      // INSERT should work without cache entry
      source$.next({ type: RowUpdateType.Insert, row: { id: 1, name: 'Test' } });
      
      source$.complete();
    });
    
  });
});