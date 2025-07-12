import { describe, it, expect } from 'vitest';
import { ViewCache } from '../shared/viewCache.js';
import type { StreamEvent } from '../shared/viewCache.js';

describe('Row Insertion Order Preservation', () => {
  it('should preserve insertion order in snapshots', () => {
    const cache = new ViewCache('id', 'test_view');
    
    // Insert rows in a specific order
    const events: StreamEvent[] = [
      {
        row: { id: '3', name: 'Third' },
        diff: 1,
      },
      {
        row: { id: '1', name: 'First' },
        diff: 1,
      },
      {
        row: { id: '2', name: 'Second' },
        diff: 1,
      },
    ];

    // Apply events to cache in order
    events.forEach(event => cache.applyStreamEvent(event));

    // Get snapshot - should be in insertion order (3, 1, 2)
    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '3', name: 'Third' });
    expect(snapshot[1]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[2]).toEqual({ id: '2', name: 'Second' });
  });

  it('should preserve position on update (replace in-place)', () => {
    const cache = new ViewCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First', value: 10 }, diff: 1 },
      { row: { id: '2', name: 'Second', value: 20 }, diff: 1 },
      { row: { id: '3', name: 'Third', value: 30 }, diff: 1 },
    ];

    initialEvents.forEach(event => cache.applyStreamEvent(event));

    // Update the middle row
    cache.applyStreamEvent({
      row: { id: '2', name: 'Second Updated', value: 25 },
      diff: 1,
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First', value: 10 });
    expect(snapshot[1]).toEqual({ id: '2', name: 'Second Updated', value: 25 }); // Updated in-place
    expect(snapshot[2]).toEqual({ id: '3', name: 'Third', value: 30 });
  });

  it('should remove row on delete', () => {
    const cache = new ViewCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1 },
      { row: { id: '2', name: 'Second' }, diff: 1 },
      { row: { id: '3', name: 'Third' }, diff: 1 },
    ];

    initialEvents.forEach(event => cache.applyStreamEvent(event));

    // Delete the middle row
    cache.applyStreamEvent({
      row: { id: '2', name: 'Second' },
      diff: -1,
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[1]).toEqual({ id: '3', name: 'Third' }); // Order preserved after deletion
  });

  it('should append new inserts to the end', () => {
    const cache = new ViewCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1 },
      { row: { id: '2', name: 'Second' }, diff: 1 },
    ];

    initialEvents.forEach(event => cache.applyStreamEvent(event));

    // Insert a new row
    cache.applyStreamEvent({
      row: { id: '3', name: 'Third' },
      diff: 1,
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[1]).toEqual({ id: '2', name: 'Second' });
    expect(snapshot[2]).toEqual({ id: '3', name: 'Third' }); // Appended to end
  });

  it('should handle complex sequence of operations', () => {
    const cache = new ViewCache('id', 'test_view');
    
    // Complex sequence: insert, update, delete, insert
    const events: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1 },      // insert
      { row: { id: '2', name: 'Second' }, diff: 1 },     // insert
      { row: { id: '3', name: 'Third' }, diff: 1 },      // insert
      { row: { id: '2', name: 'Updated Second' }, diff: 1 }, // update in-place
      { row: { id: '1', name: 'First' }, diff: -1 },     // delete
      { row: { id: '4', name: 'Fourth' }, diff: 1 },     // insert (append)
    ];

    events.forEach(event => cache.applyStreamEvent(event));

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '2', name: 'Updated Second' }); // Was position 2, now position 1 after deletion
    expect(snapshot[1]).toEqual({ id: '3', name: 'Third' });          // Was position 3, now position 2 after deletion
    expect(snapshot[2]).toEqual({ id: '4', name: 'Fourth' });         // Appended to end
  });
});