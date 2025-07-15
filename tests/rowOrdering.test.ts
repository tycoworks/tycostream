import { describe, it, expect } from 'vitest';
import { ViewCache } from '../shared/viewCache.js';
import type { StreamEvent } from '../shared/viewCache.js';
import { createTestCache } from './test-utils.js';

describe('Row Insertion Order Preservation', () => {
  it('should preserve insertion order in snapshots', () => {
    const cache = createTestCache('id', 'test_view');
    
    // Insert rows in a specific order
    const events: StreamEvent[] = [
      {
        row: { id: '3', name: 'Third' },
        diff: 1,
        timestamp: BigInt(1000),
      },
      {
        row: { id: '1', name: 'First' },
        diff: 1,
        timestamp: BigInt(2000),
      },
      {
        row: { id: '2', name: 'Second' },
        diff: 1,
        timestamp: BigInt(3000),
      },
    ];

    // Apply events to cache in order
    events.forEach(event => cache.handleRowUpdate(event));

    // Get snapshot - should be in insertion order (3, 1, 2)
    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '3', name: 'Third' });
    expect(snapshot[1]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[2]).toEqual({ id: '2', name: 'Second' });
  });

  it('should preserve position on update (replace in-place)', () => {
    const cache = createTestCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First', value: 10 }, diff: 1, timestamp: BigInt(1000) },
      { row: { id: '2', name: 'Second', value: 20 }, diff: 1, timestamp: BigInt(2000) },
      { row: { id: '3', name: 'Third', value: 30 }, diff: 1, timestamp: BigInt(3000) },
    ];

    initialEvents.forEach(event => cache.handleRowUpdate(event));

    // Update the middle row
    cache.handleRowUpdate({
      row: { id: '2', name: 'Second Updated', value: 25 },
      diff: 1,
      timestamp: BigInt(4000),
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First', value: 10 });
    expect(snapshot[1]).toEqual({ id: '2', name: 'Second Updated', value: 25 }); // Updated in-place
    expect(snapshot[2]).toEqual({ id: '3', name: 'Third', value: 30 });
  });

  it('should remove row on delete', () => {
    const cache = createTestCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1, timestamp: BigInt(1000) },
      { row: { id: '2', name: 'Second' }, diff: 1, timestamp: BigInt(2000) },
      { row: { id: '3', name: 'Third' }, diff: 1, timestamp: BigInt(3000) },
    ];

    initialEvents.forEach(event => cache.handleRowUpdate(event));

    // Delete the middle row
    cache.handleRowUpdate({
      row: { id: '2', name: 'Second' },
      diff: -1,
      timestamp: BigInt(4000),
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(2);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[1]).toEqual({ id: '3', name: 'Third' }); // Order preserved after deletion
  });

  it('should append new inserts to the end', () => {
    const cache = createTestCache('id', 'test_view');
    
    // Insert initial rows
    const initialEvents: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1, timestamp: BigInt(1000) },
      { row: { id: '2', name: 'Second' }, diff: 1, timestamp: BigInt(2000) },
    ];

    initialEvents.forEach(event => cache.handleRowUpdate(event));

    // Insert a new row
    cache.handleRowUpdate({
      row: { id: '3', name: 'Third' },
      diff: 1,
      timestamp: BigInt(3000),
    });

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '1', name: 'First' });
    expect(snapshot[1]).toEqual({ id: '2', name: 'Second' });
    expect(snapshot[2]).toEqual({ id: '3', name: 'Third' }); // Appended to end
  });

  it('should handle complex sequence of operations', () => {
    const cache = createTestCache('id', 'test_view');
    
    // Complex sequence: insert, update, delete, insert
    const events: StreamEvent[] = [
      { row: { id: '1', name: 'First' }, diff: 1, timestamp: BigInt(1000) },      // insert
      { row: { id: '2', name: 'Second' }, diff: 1, timestamp: BigInt(2000) },     // insert
      { row: { id: '3', name: 'Third' }, diff: 1, timestamp: BigInt(3000) },      // insert
      { row: { id: '2', name: 'Updated Second' }, diff: 1, timestamp: BigInt(4000) }, // update in-place
      { row: { id: '1', name: 'First' }, diff: -1, timestamp: BigInt(5000) },     // delete
      { row: { id: '4', name: 'Fourth' }, diff: 1, timestamp: BigInt(6000) },     // insert (append)
    ];

    events.forEach(event => cache.handleRowUpdate(event));

    const snapshot = cache.getAllRows();
    
    expect(snapshot).toHaveLength(3);
    expect(snapshot[0]).toEqual({ id: '2', name: 'Updated Second' }); // Was position 2, now position 1 after deletion
    expect(snapshot[1]).toEqual({ id: '3', name: 'Third' });          // Was position 3, now position 2 after deletion
    expect(snapshot[2]).toEqual({ id: '4', name: 'Fourth' });         // Appended to end
  });
});