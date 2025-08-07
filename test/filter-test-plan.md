# Filter Testing Plan

## Snapshot vs Live Stream Sharing Architecture

### Problem
We need to share filtered live streams across multiple subscribers while ensuring each subscriber gets their own snapshot replay. The current architecture with `share()` at ViewService level breaks snapshot delivery for late-joining subscribers.

### Solution
Split the StreamingService into separate snapshot and live stream methods:

1. **StreamingService Changes:**
   - Add `getSnapshot()` - Returns Observable of cached rows (completes after sending)
   - Add `getSharedLiveUpdates()` - Returns shared Observable of live updates only
   - Keep `getUpdates()` for backward compatibility using `concat(snapshot$, live$)`

2. **View Changes:**
   - Each subscriber gets their own filtered snapshot via `streamingService.getSnapshot()`
   - All subscribers share filtered live updates via cached `streamingService.getSharedLiveUpdates()`
   - Use `concat()` to combine: snapshot first, then live updates

3. **ViewService Changes:**
   - Remove `share()` operator - let View handle the sharing logic
   - Keep view caching but remove stream caching
   - Each `getUpdates()` call returns `view.getUpdates()` directly

### Benefits
- Each subscriber gets complete data (snapshot + live)
- Filter computation is shared for live updates (CPU efficiency)
- Clean separation of concerns
- No manual subscriber counting needed

### Implementation Order
1. Add new methods to StreamingService (getSnapshot, getSharedLiveUpdates)
2. Update View to use split streams with concat
3. Simplify ViewService to remove stream caching
4. Test with multiple subscribers to verify snapshot delivery

## RxJS Cleanup Pattern for Zero Subscribers

When implementing cleanup for zero subscribers, use the `finalize` operator pattern:

```typescript
// In ViewService
private createTrackedStream(view: View, cacheKey: string): Observable<RowUpdateEvent> {
  return view.getUpdates().pipe(
    finalize(() => {
      // This runs when last subscriber disconnects
      console.log(`All subscribers disconnected for view: ${cacheKey}`);
      this.viewCache.delete(cacheKey);
      view.dispose();
      
      // Check if this was the last view for the source
      const sourceName = cacheKey.split(':')[0];
      if (!this.hasActiveViews(sourceName)) {
        this.streamingManager.disposeSource(sourceName);
      }
    }),
    share() // Share the stream among multiple subscribers
  );
}
```

Benefits:
- No manual subscriber counting needed
- RxJS handles the lifecycle automatically
- Cleanup runs exactly when refCount hits 0
- Works naturally with share() operator

## Overview

This document outlines the testing strategy for GraphQL subscription filters in tycostream.

## Integration Test - Smoke Test

Simple single-client test to verify basic filtering functionality:

```typescript
it('should filter subscription results based on where clause', async () => {
  // Single client subscribes with filter: active = true
  // Insert users with different active states:
  //   - user_id: 1, active: true
  //   - user_id: 2, active: false
  //   - user_id: 3, active: true
  //   - user_id: 4, active: false
  // 
  // Expected: Client receives only users 1 and 3
  // Verify INSERT events only for active users
  // Verify UPDATE events that change active status trigger appropriate INSERT/DELETE
});
```

## Stress Test - Comprehensive Filter Testing

### Schema Modification

Add `department` field to stress_test table:
```sql
CREATE TABLE stress_test (
  id INTEGER NOT NULL,
  value NUMERIC NOT NULL,
  status VARCHAR(10) NOT NULL,
  department VARCHAR(20) NOT NULL
)
```

### Deterministic Assignment Strategy

**Departments:**
```typescript
const departments = ['sales', 'engineering', 'operations', 'finance'];
```

**Row Department Assignment:**
```typescript
// Based on row ID for initial INSERT
const department = departments[rowId % departments.length];
// Results in:
// ID 1,5,9,13...  → sales
// ID 2,6,10,14... → engineering  
// ID 3,7,11,15... → operations
// ID 4,8,12,16... → finance
```

**Client Department Assignment:**
```typescript
// Round-robin based on client index
const clientDepartment = departments[clientIndex % departments.length];
// Results in:
// Client 0,4,8...  → subscribes to sales
// Client 1,5,9...  → subscribes to engineering
// Client 2,6,10... → subscribes to operations
// Client 3,7,11... → subscribes to finance
```

**Department Changes During Updates:**
```typescript
// Deterministic department changes to test view enter/leave
if (i % 20 === 0 && updateId % 3 === 0) {
  // Move to next department in cycle
  const currentDeptIndex = departments.indexOf(currentDepartment);
  const newDepartment = departments[(currentDeptIndex + 1) % departments.length];
  // This causes rows to move between client views
}
```

### Expected Behavior

1. Each client only receives events for their department
2. When a row's department changes:
   - Old department clients receive DELETE
   - New department clients receive INSERT
3. Multiple clients with same department share the same View instance internally
4. Each client converges to different final state (their department's rows)

### Test Validation

- Track events per client by department
- Verify final state matches expected department data
- Confirm no cross-department data leakage
- Validate proper INSERT/DELETE on department changes

## Benefits of This Approach

1. **Deterministic**: Same results every test run
2. **Comprehensive**: Tests all filtering scenarios
3. **Realistic**: Simulates actual row-level security use case
4. **Performance**: Exercises view sharing and caching
5. **Debuggable**: Predictable patterns make failures easier to diagnose