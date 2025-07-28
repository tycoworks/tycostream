# GraphQL Subscription Filters

This document outlines the design and implementation of Hasura-compatible filtering for tycostream subscriptions.

## Overview

tycostream implements client-side filtering to:
- Support concurrent subscriptions with different filters over the main data cache
- Avoid creating database views for every filter combination
- Enable future features like sorting and infinite scrolling in the same layer

## Table of Contents

1. [MVP Scope](#mvp-scope)
2. [Implementation Phases](#implementation-phases)
3. [User Experience (Hasura-Compatible)](#user-experience-hasura-compatible)
4. [The View Concept](#the-view-concept)
5. [Technical Implementation](#technical-implementation)
6. [Performance Optimizations](#performance-optimizations)
7. [Implementation Checklist](#implementation-checklist)
8. [Future Enhancements](#future-enhancements)

## MVP Scope

### Phase 1 - Core Operators

The initial implementation supports the most commonly used operators:

**Comparison**: `_eq`, `_neq`, `_gt`, `_lt`, `_gte`, `_lte`  
**List**: `_in`, `_nin`  
**Null**: `_is_null`  
**Logical**: `_and`, `_or`, `_not`

This covers ~80% of filtering use cases while keeping implementation simple.

### Not in MVP

- Text operators (`_like`, `_ilike`, `_regex`)
- JSON/JSONB operators  
- Array operators
- Nested relationship filtering

## Implementation Phases

### Phase 1: Delta Updates Foundation
- Implement field-level change detection in `materialize-protocol.ts`
- Modify `RowUpdateEvent` to include delta information
- Update GraphQL schema to support optional delta field
- Normalize DELETE events to only contain primary key field
- Full test coverage for delta detection

### Phase 2: GraphQL Filter Parsing
- Add `where` argument to subscription schema
- Parse GraphQL where clauses to JavaScript expressions
- Log filter expressions but don't apply them yet
- Test filter expression generation
- Clean up string literal duplication in subscription-resolvers.ts (ROW_UPDATE_TYPE_MAP)

### Phase 3: View Infrastructure
- Create `View` class as a filtered stream
- DatabaseStreamingService creates Views (encapsulation)
- Views track visible keys, not full data
- Views get row data via callback function

### Phase 4: Filter Implementation
- Update DatabaseStreamingManagerService.getUpdates() to accept filter
- Compile filter expressions to functions with dependency tracking
- Cache streams by (source + filter expression) key
- Generate INSERT/UPDATE/DELETE events as items enter/leave filter
- Optimize: skip re-evaluation when changed fields don't affect filter

### Phase 5: Optimizations
- Skip evaluation when unchanged fields (using deltas)
- Async view processing (update cache synchronously, process views async)
- Memory optimization strategies

## User Experience (Hasura-Compatible)

### Basic Filtering

Users should be able to filter subscriptions using a `where` argument with an intuitive syntax:

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


## The View Concept

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
    source$: Observable<[RowUpdateEvent, bigint]>,
    filter: CompiledFilter | null,
    primaryKey: string,
    getRow: (key: any) => any  // Callback to get full row data
  ) {}
  
  // Return filtered stream of events
  getUpdates(): Observable<RowUpdateEvent>;
}

interface RowUpdateEvent {
  type: RowUpdateType;
  fields: Record<string, any>; // All fields for INSERT, changed for UPDATE, key for DELETE
}
```

### State Transition Logic

When processing an update:
1. Apply filter to new row data
2. Check if row was previously in view
3. Generate appropriate event:
   - Was in view, still matches → UPDATE (with delta)
   - Was in view, no longer matches → DELETE  
   - Wasn't in view, now matches → INSERT
   - Wasn't in view, still doesn't match → (ignore)

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

// Note: compileFilter is now handled internally in DatabaseStreamingService
// The GraphQL layer only needs to convert where clause to expression string
```

### 2. Enhanced DatabaseStreamingManagerService

```typescript
// database-streaming-manager.service.ts
class DatabaseStreamingManagerService {
  getUpdates(sourceName: string, filterExpression?: string): Observable<RowUpdateEvent> {
    const sourceDef = this.sourceDefinitions.get(sourceName);
    if (!sourceDef) throw new Error(`Unknown source: ${sourceName}`);
    
    let streamingService = this.streamingServices.get(sourceName);
    if (!streamingService) {
      streamingService = this.createStreamingService(sourceDef);
      this.streamingServices.set(sourceName, streamingService);
      this.logger.log(`Created streaming service for source: ${sourceName}`);
    }
    
    // Pass filter expression through to streaming service
    return streamingService.getUpdates(filterExpression);
  }
}

// database-streaming.service.ts
class DatabaseStreamingService {
  private viewCache = new Map<string, Observable<RowUpdateEvent>>();
  
  // Overloaded getUpdates method - called without params returns unfiltered stream
  getUpdates(): Observable<RowUpdateEvent>;
  getUpdates(filterExpression: string): Observable<RowUpdateEvent>;
  getUpdates(filterExpression?: string): Observable<RowUpdateEvent> {
    // Use empty string for unfiltered as cache key
    const cacheKey = filterExpression || '';
    
    // Check cache first
    let viewObservable = this.viewCache.get(cacheKey);
    if (!viewObservable) {
      // Compile filter if provided
      const compiledFilter = filterExpression 
        ? new Function('datum', `return ${filterExpression}`) 
        : null;
      
      // Create new view (internal implementation detail)
      const view = new View(
        this.internalUpdates$,
        compiledFilter,
        this.sourceDef.primaryKeyField,
        (key) => this.cache.get(key)  // Row getter callback
      );
      
      viewObservable = view.getUpdates();
      this.viewCache.set(cacheKey, viewObservable);
    }
    
    return viewObservable;
  }
}
```

### 3. Subscription Resolver Integration

```typescript
// GraphQL layer converts where clause to expression string
function createFilteredSubscriptionResolver(
  sourceName: string,
  streamingManager: DatabaseStreamingManagerService
) {
  return {
    subscribe: (parent, args, context, info) => {
      // Convert GraphQL where to expression string (or null)
      const filterExpression = args.where ? whereToExpression(args.where) : null;
      
      // Pass expression string to database layer
      const observable = streamingManager.getUpdates(sourceName, filterExpression);
      
      // Rest remains the same
      const graphqlUpdates$ = observable.pipe(
        map((event: RowUpdateEvent) => ({
          [sourceName]: {
            operation: ROW_UPDATE_TYPE_STRINGS[event.type],
            data: event.fields
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

### 3. Delta Optimization

With delta updates from Phase 1, views can skip processing when irrelevant fields change:

```typescript
class View {
  constructor(
    private source$: Observable<[RowUpdateEvent, bigint]>,
    private filter: ((row: any) => boolean) | null,
    private primaryKey: string,
    private getRow: (key: any) => any
  ) {}
  
  processUpdate(event: RowUpdateEvent): RowUpdateEvent | null {
    const key = event.fields[this.primaryKey];
    const wasInView = this.visibleKeys.has(key);
    
    // TODO: Future optimization - check if changed fields affect filter result
    // For now, always re-evaluate filter when row changes
    
    // Need full row to evaluate filter
    const fullRow = event.type === RowUpdateType.Delete 
      ? event.fields 
      : this.getRow(key);
      
    const isInView = this.filter.evaluate(fullRow);
    
    // Generate appropriate view event based on state transition
    // ...
  }
}
```

## Implementation Checklist

### Core Components

1. **Delta Updates**: Field-level change detection in protocol layer
2. **Filter Compilation**: GraphQL where → JavaScript function with dependency tracking
3. **Enhanced DatabaseStreamingManagerService**: Handles view creation and caching
4. **View Class**: Lightweight filtered stream with visibility tracking
5. **Minimal GraphQL Changes**: Just pass filter to getUpdates()

### Code Organization

```
src/
  database/
    database-view.ts              # View class (filtered stream)
    database-streaming.service.ts      # Enhanced getUpdates() with filter param
    database-streaming-manager.service.ts  # Enhanced getUpdates() with filter param
    
  graphql/
    filter-compiler.ts   # whereToExpression function - converts GraphQL where to expression
```

### Architecture Benefits

- **Encapsulation**: Views can only access cache through callbacks
- **Simplicity**: No separate ViewManager needed  
- **Consistency**: Always async boundary, filtered or not
- **Composability**: Views are just filtered streams

### Design Decisions

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
2. **Delta Protocol**: Send only changed fields instead of full rows
3. **Filter Validation**: Compile-time validation against source schema
4. **Entitlements**: Row-level security as additional filter predicates