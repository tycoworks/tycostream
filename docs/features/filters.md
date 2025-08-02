# GraphQL Subscription Filters

## Overview

tycostream needs to support filtering for GraphQL subscriptions, allowing clients to subscribe to subsets of data using Hasura-compatible `where` clauses. This document explores the design options and implementation approach.

## Table of Contents

1. [User Experience](#user-experience)
2. [Architectural Decision](#architectural-decision)
3. [The View Concept](#the-view-concept)
4. [Implementation Phases](#implementation-phases)
5. [Technical Implementation](#technical-implementation)
6. [Performance Optimizations](#performance-optimizations)
7. [Future Enhancements](#future-enhancements)

## User Experience

tycostream will support Hasura-compatible filtering, allowing users to filter subscriptions using a `where` argument with an intuitive syntax.

### MVP Scope

The initial implementation supports the most commonly used operators:

**Comparison**: `_eq`, `_neq`, `_gt`, `_lt`, `_gte`, `_lte`  
**List**: `_in`, `_nin`  
**Null**: `_is_null`  
**Logical**: `_and`, `_or`, `_not`

This covers ~80% of filtering use cases while keeping implementation simple.

**Not in MVP**: Text operators (`_like`, `_ilike`, `_regex`), JSON/JSONB operators, array operators, and nested relationship filtering.

### Basic Filtering

```graphql
subscription ActiveUsers {
  users(where: { is_active: { _eq: true } }) {
    id
    name
    is_active
    last_login
  }
}
```

### Complex Filtering

Support for complex boolean expressions using logical operators:

```graphql
subscription RecentActiveUsers {
  users(
    where: {
      _and: [
        { is_active: { _eq: true } },
        { last_login: { _gt: "2024-01-01T00:00:00Z" } }
      ]
    }
  ) {
    id
    name
    last_login
  }
}
```

## Architectural Decision

To support the filtering requirements above, we need to decide where filtering happens. There are two main approaches, each with trade-offs:

### Option 1: Push Filters to Materialize (Database-side)
Create a new Materialize view for each unique `where` clause, letting the database handle all filtering.

**Pros:**
- Leverages Materialize's optimized query engine
- Filters run close to the data
- No additional filtering logic in tycostream

**Cons:**
- Each unique filter requires a separate SUBSCRIBE connection
- 1000 users with slightly different filters = 1000 database connections
- No support for row-level security or user-context filtering
- View explosion problem (potentially thousands of views)

### Option 2: Filter in tycostream (Client-side)
Maintain one shared cache per base view and apply filters in tycostream before sending to clients.

**Pros:**
- Single database connection serves many filtered subscriptions
- Foundation for row-level security and entitlements
- Enables additional features (sorting, pagination, field masking)
- Clear architectural separation of concerns

**Cons:**
- Filtering logic runs in Node.js instead of optimized database
- tycostream uses more memory to track view states
- Additional complexity in tycostream codebase

### Our Choice: Client-Side Filtering

We chose Option 2 (client-side filtering) because:

**Connection Efficiency**: Each unique filter combination would require a separate SUBSCRIBE connection to Materialize. With 1000 users having slightly different filters, this would create 1000 database connections, each with cursor and memory overhead.

**Row-Level Security**: Materialize has role-based access control (RBAC) for table/view permissions, but lacks row-level security (RLS) - the ability to filter which rows users can see based on their identity or context. Client-side filtering provides a foundation for implementing rules like "traders only see their own trades".

**Architectural Clarity**: Clear separation of concerns - Materialize handles computation and incremental view maintenance, while tycostream handles data distribution and user-specific filtering.

**Future Flexibility**: The filtering layer enables features beyond just `where` clauses, such as sorting, pagination, field masking, and rate limiting.

## The View Concept

With client-side filtering chosen, we need a way to maintain filtered subsets of the main cache for each subscription. This is where "views" come in - lightweight filtered streams that track which rows from the main cache are visible to each client.

### Why Views?

Simple filtering (`stream.filter(predicate)`) doesn't work for subscriptions because:
- Items that stop matching the filter need DELETE events sent to clients
- Items that start matching the filter need INSERT events
- Clients expect a consistent view of their filtered data

### View Abstraction

Each subscription maintains a "view" - a filtered subset of the main cache:

```typescript
class View {
  // Track visibility state only
  private visibleKeys = new Set<string | number>();
  
  constructor(
    source$: Observable<RowUpdateEvent>,
    filter: Filter | null,  // null for unfiltered views
    primaryKey: string,
    getRow: (key: any) => any,              // Get single row
    getAllRows: () => any[]                 // Get snapshot for initial state
  ) {
    // On construction, send INSERT events for all matching rows
    this.sendInitialSnapshot();
  }
  
  // Return filtered stream of events
  getUpdates(): Observable<RowUpdateEvent>;
}

interface RowUpdateEvent {
  type: RowUpdateType;
  row: Record<string, any>; // All fields for INSERT, changed fields for UPDATE, key only for DELETE
}
```

### State Transition Logic

When processing an update:
1. Apply filter to new row data
2. Check if row was previously in view
3. Generate appropriate event:
   - Was in view, still matches → UPDATE (with only changed fields)
   - Was in view, no longer matches → DELETE  
   - Wasn't in view, now matches → INSERT
   - Wasn't in view, still doesn't match → (ignore)

## Implementation Phases

Now that we've decided on client-side filtering with views, here's how we'll implement it:

### Phase 1: GraphQL Filter Parsing
- Add `where` argument to subscription schema
- Parse GraphQL where clauses to JavaScript expressions
- Log filter expressions but don't apply them yet
- Test filter expression generation

### Phase 2: View Infrastructure
- Create `View` class as a filtered stream
- DatabaseStreamingService creates Views (encapsulation)
- Views track visible keys, not full data
- Views get row data via callback function

### Phase 3: Filter Implementation
- Update StreamingManagerService.getUpdates() to accept Filter object
- StreamingService creates Views for filtered subscriptions
- All subscriptions (filtered or unfiltered) use Views for consistency
- **Refactor: Move snapshot logic from StreamingService to View**
  - Remove from StreamingService: `sendSnapshot()`, `subscribeToLiveUpdates()`, `createCleanupObservable()`, consumer counting
  - Add to View: Initial snapshot handling in constructor
  - View sends INSERT events for all matching rows on creation
  - Move snapshot-related tests from `streaming.service.spec.ts` to `view.spec.ts`
- Views cached by filter expression
- Generate INSERT/UPDATE/DELETE events as items enter/leave filter
- Optimize: skip re-evaluation when changed fields don't affect filter

**Step-by-step refactoring plan:**
1. Update View constructor to accept `getAllRows` callback
2. Add snapshot logic to View - send INSERT for each matching row
3. Update StreamingService.getUpdates() to always create a View (remove conditional)
4. Remove ReplaySubject and snapshot methods from StreamingService
5. Move these tests from streaming.service.spec.ts to view.spec.ts:
   - "should send cache snapshot to new subscribers"
   - "should not duplicate events for late joiners"
   - "should filter updates by timestamp correctly"
6. Update consumer counting to work at View level (if needed)

### Phase 4: Optimizations
- Skip evaluation when unchanged fields (leveraging field-level updates)
- Async view processing (update cache synchronously, process views async)
- Memory optimization strategies

## Technical Implementation

### 1. Converting GraphQL to Filter Functions

```typescript
// Convert GraphQL where clause to JavaScript expression string
function whereToExpression(where: any, fieldVar = 'datum'): string {
  if (where._and) {
    return where._and.map(w => whereToExpression(w, fieldVar)).join(' && ');
  }
  if (where._or) {
    return where._or.map(w => whereToExpression(w, fieldVar)).join(' || ');
  }
  if (where._not) {
    return `!(${whereToExpression(where._not, fieldVar)})`;
  }
  
  // Handle field comparisons
  const field = Object.keys(where)[0];
  const operators = where[field];
  const op = Object.keys(operators)[0];
  const value = operators[op];
  
  switch (op) {
    case '_eq': return `${fieldVar}.${field} === ${JSON.stringify(value)}`;
    case '_neq': return `${fieldVar}.${field} !== ${JSON.stringify(value)}`;
    case '_gt': return `${fieldVar}.${field} > ${value}`;
    case '_lt': return `${fieldVar}.${field} < ${value}`;
    case '_gte': return `${fieldVar}.${field} >= ${value}`;
    case '_lte': return `${fieldVar}.${field} <= ${value}`;
    case '_in': return `[${value.map(JSON.stringify).join(',')}].indexOf(${fieldVar}.${field}) !== -1`;
    case '_is_null': return value ? `${fieldVar}.${field} == null` : `${fieldVar}.${field} != null`;
    // ... other operators
  }
}

// GraphQL layer creates a Filter object with compiled function
interface Filter {
  evaluate: (row: any) => boolean;
  fields: Set<string>;  // Fields used in filter for optimization
  expression: string;   // For debugging and cache key
}
```

### 2. Enhanced StreamingManagerService

```typescript
// streaming-manager.service.ts
class StreamingManagerService {
  getUpdates(sourceName: string, filter?: Filter | null): Observable<RowUpdateEvent> {
    const sourceDef = this.sourceDefinitions.get(sourceName);
    if (!sourceDef) throw new Error(`Unknown source: ${sourceName}`);
    
    let streamingService = this.streamingServices.get(sourceName);
    if (!streamingService) {
      streamingService = this.createStreamingService(sourceDef);
      this.streamingServices.set(sourceName, streamingService);
      this.logger.log(`Created streaming service for source: ${sourceName}`);
    }
    
    // Pass filter object through to streaming service
    return streamingService.getUpdates(filter);
  }
}

// streaming.service.ts
class StreamingService {
  private viewCache = new Map<string, Observable<RowUpdateEvent>>();
  
  getUpdates(filter?: Filter | null): Observable<RowUpdateEvent> {
    // Use filter expression as cache key (empty string for unfiltered)
    const cacheKey = filter?.expression || '';
    
    // Check cache first
    let viewObservable = this.viewCache.get(cacheKey);
    if (!viewObservable) {
      // Always create a View (even for unfiltered subscriptions)
      const view = new View(
        this.internalUpdates$,
        filter,
        this.sourceDef.primaryKeyField,
        (key) => this.cache.get(key),      // Row getter callback
        () => this.cache.getAllRows()       // Snapshot callback
      );
      
      // Share the observable among all subscribers with same filter
      viewObservable = view.getUpdates().pipe(share());
      this.viewCache.set(cacheKey, viewObservable);
    }
    
    return viewObservable;
  }
}
```

### 3. Subscription Resolver Integration

```typescript
// GraphQL layer creates Filter object and passes to streaming layer
function createSourceSubscriptionResolver(
  sourceName: string,
  streamingManager: StreamingManagerService
) {
  return {
    subscribe: (parent, args, context, info) => {
      // Build Filter object from GraphQL where clause
      const filter = buildFilter(args.where);
      
      // Pass filter to streaming layer
      const observable = streamingManager.getUpdates(sourceName, filter);
      
      // Rest remains the same
      const graphqlUpdates$ = observable.pipe(
        map((event: RowUpdateEvent) => ({
          [sourceName]: {
            operation: ROW_UPDATE_TYPE_STRINGS[event.type],
            data: event.row
          }
        }))
      );
      
      return eachValueFrom(graphqlUpdates$);
    }
  };
}
```

## Performance Optimizations

### 1. Filter Compilation Caching

Compiled filters are cached by expression string to avoid re-parsing identical filters across views.

### 2. View State Management

- Store only primary keys in views, not full row copies
- Reference main cache for row data
- Use efficient data structures (Sets) for O(1) visibility checks

### 3. Field-Level Update Optimization

tycostream already sends only changed fields for UPDATE operations. Views can leverage this to skip processing when irrelevant fields change:

```typescript
class View {
  constructor(
    private source$: Observable<[RowUpdateEvent, bigint]>,
    private filter: ((row: any) => boolean) | null,
    private primaryKey: string,
    private getRow: (key: any) => any
  ) {}
  
  processUpdate(event: RowUpdateEvent): RowUpdateEvent | null {
    const key = event.row[this.primaryKey];
    const wasInView = this.visibleKeys.has(key);
    
    // TODO: Future optimization - check if changed fields affect filter result
    // For now, always re-evaluate filter when row changes
    
    // Need full row to evaluate filter
    const fullRow = event.type === RowUpdateType.Delete 
      ? event.row 
      : this.getRow(key);
      
    const isInView = this.filter.evaluate(fullRow);
    
    // Generate appropriate view event based on state transition
    // ...
  }
}
```

## Design Decisions

**Filter Format**: Expression string approach
- GraphQL layer converts `where` to expression string
- Simple interface between layers
- Expression string serves as both executable code and cache key
- Human-readable for debugging
- Can later use Vega to parse back to AST for dependency tracking
- Avoids coupling GraphQL AST format to database layer

**Always Create View**: Even without filter
- Ensures consistent async behavior
- Prevents sync updates blocking main thread
- Simplifies code paths

### Missing Pieces

- **View Lifecycle**: Clean up views when no subscribers (similar to database streams)
- **Error Handling**: Invalid filter syntax, runtime evaluation errors
- **Memory Limits**: Prevent unbounded view growth
- **Metrics**: Filter performance, view sizes, cache hit rates

## Future Enhancements

1. **Additional Operators**: Text search, JSON/JSONB, arrays (see MVP scope)
2. **Advanced Field-Level Optimizations**: Skip filter evaluation when changed fields don't affect filter predicates
3. **Filter Validation**: Compile-time validation against source schema
4. **Entitlements**: Row-level security as additional filter predicates