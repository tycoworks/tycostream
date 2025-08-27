import { Test, TestingModule } from '@nestjs/testing';
import { ViewService } from './view.service';
import { SourceService } from './source.service';
import { Source } from './source';
import { Filter } from './filter';
import { RowUpdateEvent, RowUpdateType } from './types';
import { Subject } from 'rxjs';
import { take, toArray } from 'rxjs/operators';

describe('ViewService', () => {
  let viewService: ViewService;
  let sourceService: jest.Mocked<SourceService>;
  let mockSource: jest.Mocked<Source>;
  let sourceUpdates$: Subject<RowUpdateEvent>;

  beforeEach(async () => {
    // Create a subject we can control for testing
    sourceUpdates$ = new Subject<RowUpdateEvent>();

    // Mock Source
    mockSource = {
      getUpdates: jest.fn().mockReturnValue(sourceUpdates$),
      getPrimaryKeyField: jest.fn().mockReturnValue('id'),
      onModuleDestroy: jest.fn()
    } as any;

    // Mock SourceService
    sourceService = {
      getSource: jest.fn().mockReturnValue(mockSource)
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ViewService,
        { provide: SourceService, useValue: sourceService }
      ],
    }).compile();

    viewService = module.get<ViewService>(ViewService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    sourceUpdates$.complete();
  });

  describe('getUpdates without filter', () => {
    it('should pass through all events from source when no filter provided', async () => {
      // Get unfiltered stream
      const updates$ = viewService.getUpdates('test_source');
      
      // Collect events
      const eventsPromise = updates$.pipe(take(3), toArray()).toPromise();

      // Emit test events
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Alice' }
      });
      
      sourceUpdates$.next({
        type: RowUpdateType.Update,
        fields: new Set(['id', 'name']),
        row: { id: 1, name: 'Alice Updated' }
      });
      
      sourceUpdates$.next({
        type: RowUpdateType.Delete,
        fields: new Set(['id']),
        row: { id: 1 }
      });

      const events = await eventsPromise;
      
      expect(events).toHaveLength(3);
      expect(events![0].type).toBe(RowUpdateType.Insert);
      expect(events![1].type).toBe(RowUpdateType.Update);
      expect(events![2].type).toBe(RowUpdateType.Delete);
      expect(sourceService.getSource).toHaveBeenCalledWith('test_source');
    });
  });

  describe('getUpdates with filter', () => {
    it('should only emit events matching the filter', async () => {
      // Create a filter for active users
      const filter = new Filter({
        expression: 'datum.active === true',
        fields: new Set(['active']),
        evaluate: (row: any) => row.active === true
      });

      // Get filtered stream
      const updates$ = viewService.getUpdates('test_source', filter);
      
      // Collect events
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // Emit test events - mix of matching and non-matching
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 1, name: 'Active User', active: true }
      });

      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 2, name: 'Inactive User', active: false }
      });

      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'active']),
        row: { id: 3, name: 'Another Active', active: true }
      });

      // Allow async processing
      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only have the two active users
      expect(events).toHaveLength(2);
      expect(events[0].row.id).toBe(1);
      expect(events[1].row.id).toBe(3);

      subscription.unsubscribe();
    });

    it('should emit DELETE when row leaves filtered view', async () => {
      const filter = new Filter({
        expression: 'datum.status === "active"',
        fields: new Set(['status']),
        evaluate: (row: any) => row.status === 'active'
      });

      const updates$ = viewService.getUpdates('test_source', filter);
      
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // First, insert an active item
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'name', 'status']),
        row: { id: 1, name: 'Item', status: 'active' }
      });

      // Then update it to inactive (should generate DELETE)
      sourceUpdates$.next({
        type: RowUpdateType.Update,
        fields: new Set(['id', 'status']),
        row: { id: 1, name: 'Item', status: 'inactive' }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(RowUpdateType.Insert);
      expect(events[1].type).toBe(RowUpdateType.Delete);
      expect(events[1].fields).toEqual(new Set(['id'])); // DELETE only sends PK

      subscription.unsubscribe();
    });

    it('should emit INSERT when row enters filtered view', async () => {
      const filter = new Filter({
        expression: 'datum.priority === "high"',
        fields: new Set(['priority']),
        evaluate: (row: any) => row.priority === 'high'
      });

      const updates$ = viewService.getUpdates('test_source', filter);
      
      const events: RowUpdateEvent[] = [];
      const subscription = updates$.subscribe(event => events.push(event));

      // First, insert a low priority item (filtered out)
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'task', 'priority']),
        row: { id: 1, task: 'Task 1', priority: 'low' }
      });

      // Update it to high priority (should generate INSERT)
      sourceUpdates$.next({
        type: RowUpdateType.Update,
        fields: new Set(['id', 'priority']),
        row: { id: 1, task: 'Task 1', priority: 'high' }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should only have one INSERT event (when it became high priority)
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(RowUpdateType.Insert);
      expect(events[0].row.priority).toBe('high');
      expect(events[0].fields.has('task')).toBe(true); // INSERT includes all fields

      subscription.unsubscribe();
    });
  });

  describe('multiple subscribers', () => {
    it('should create separate views for each subscriber', async () => {
      const filter = new Filter({
        expression: 'datum.type === "A"',
        fields: new Set(['type']),
        evaluate: (row: any) => row.type === 'A'
      });

      // Create two subscribers with same filter
      const updates1$ = viewService.getUpdates('test_source', filter);
      const updates2$ = viewService.getUpdates('test_source', filter);

      const events1: RowUpdateEvent[] = [];
      const events2: RowUpdateEvent[] = [];
      
      const sub1 = updates1$.subscribe(event => events1.push(event));
      const sub2 = updates2$.subscribe(event => events2.push(event));

      // Emit event
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'type']),
        row: { id: 1, type: 'A' }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Both should receive the event
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);

      // Unsubscribe first
      sub1.unsubscribe();

      // Emit another event
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'type']),
        row: { id: 2, type: 'A' }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Only second subscriber should get the new event
      expect(events1).toHaveLength(1); // Still 1
      expect(events2).toHaveLength(2); // Now 2

      sub2.unsubscribe();
    });

    it('should handle different filters on same source independently', async () => {
      const filterA = new Filter({
        expression: 'datum.category === "A"',
        fields: new Set(['category']),
        evaluate: (row: any) => row.category === 'A'
      });

      const filterB = new Filter({
        expression: 'datum.category === "B"',
        fields: new Set(['category']),
        evaluate: (row: any) => row.category === 'B'
      });

      const updatesA$ = viewService.getUpdates('test_source', filterA);
      const updatesB$ = viewService.getUpdates('test_source', filterB);

      const eventsA: RowUpdateEvent[] = [];
      const eventsB: RowUpdateEvent[] = [];
      
      const subA = updatesA$.subscribe(event => eventsA.push(event));
      const subB = updatesB$.subscribe(event => eventsB.push(event));

      // Emit events of different categories
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'category']),
        row: { id: 1, category: 'A' }
      });

      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'category']),
        row: { id: 2, category: 'B' }
      });

      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'category']),
        row: { id: 3, category: 'A' }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Each should only have their category
      expect(eventsA).toHaveLength(2);
      expect(eventsA[0].row.id).toBe(1);
      expect(eventsA[1].row.id).toBe(3);

      expect(eventsB).toHaveLength(1);
      expect(eventsB[0].row.id).toBe(2);

      subA.unsubscribe();
      subB.unsubscribe();
    });
  });

  describe('error handling', () => {
    it('should handle errors in filter evaluation gracefully', async () => {
      const filter = new Filter({
        expression: 'datum.nested.value === true',
        fields: new Set(['nested']),
        evaluate: (row: any) => {
          // This will throw if nested is undefined
          return row.nested.value === true;
        }
      });

      const updates$ = viewService.getUpdates('test_source', filter);
      const events: RowUpdateEvent[] = [];
      const errors: any[] = [];
      
      const subscription = updates$.subscribe({
        next: event => events.push(event),
        error: err => errors.push(err)
      });

      // Emit event that will cause error in filter
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id']),
        row: { id: 1 } // No nested property
      });

      // Emit valid event
      sourceUpdates$.next({
        type: RowUpdateType.Insert,
        fields: new Set(['id', 'nested']),
        row: { id: 2, nested: { value: true } }
      });

      await new Promise(resolve => setTimeout(resolve, 10));

      // Should continue processing after error
      expect(events).toHaveLength(1);
      expect(events[0].row.id).toBe(2);
      expect(errors).toHaveLength(0); // Errors handled internally

      subscription.unsubscribe();
    });
  });
});