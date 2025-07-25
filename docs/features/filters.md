# GraphQL Subscription Filters

This document outlines the design and implementation of Hasura-inspired filtering for tycostream subscriptions, including UX considerations and technical implementation details.

## Table of Contents

1. [User Experience (Hasura-Inspired)](#user-experience-hasura-inspired)
2. [Filter Syntax and Operators](#filter-syntax-and-operators)
3. [Implementation Architecture](#implementation-architecture)
4. [State Transition Handling](#state-transition-handling)
5. [Technical Implementation](#technical-implementation)
6. [Performance Considerations](#performance-considerations)

## User Experience (Hasura-Inspired)

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

### Nested Object Filtering

For related data (future enhancement):

```graphql
subscription UsersWithRecentOrders {
  users(
    where: {
      orders: {
        created_at: { _gt: "2024-12-01T00:00:00Z" }
      }
    }
  ) {
    id
    name
    orders(where: { created_at: { _gt: "2024-12-01T00:00:00Z" } }) {
      id
      total
    }
  }
}
```

## Filter Syntax and Operators

### Comparison Operators

- `_eq`: Equal to
- `_neq`: Not equal to
- `_gt`: Greater than
- `_lt`: Less than
- `_gte`: Greater than or equal to
- `_lte`: Less than or equal to
- `_in`: In array
- `_nin`: Not in array
- `_is_null`: Is null (boolean)

### Text Operators

- `_like`: SQL LIKE pattern matching
- `_nlike`: NOT LIKE
- `_ilike`: Case-insensitive LIKE
- `_nilike`: Case-insensitive NOT LIKE
- `_regex`: Regular expression matching
- `_nregex`: Negative regex matching

### Logical Operators

- `_and`: All conditions must be true
- `_or`: At least one condition must be true
- `_not`: Negates the condition

### GraphQL Schema Generation

For each source, generate filter input types:

```graphql
input users_bool_exp {
  _and: [users_bool_exp!]
  _or: [users_bool_exp!]
  _not: users_bool_exp
  
  id: Int_comparison_exp
  name: String_comparison_exp
  email: String_comparison_exp
  is_active: Boolean_comparison_exp
  created_at: Timestamp_comparison_exp
  metadata: JSON_comparison_exp
}

input Int_comparison_exp {
  _eq: Int
  _neq: Int
  _gt: Int
  _lt: Int
  _gte: Int
  _lte: Int
  _in: [Int!]
  _nin: [Int!]
  _is_null: Boolean
}

input String_comparison_exp {
  _eq: String
  _neq: String
  _like: String
  _nlike: String
  _ilike: String
  _nilike: String
  _regex: String
  _nregex: String
  _in: [String!]
  _nin: [String!]
  _is_null: Boolean
}

# Similar for other types...
```

## Implementation Architecture

### High-Level Design

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ GraphQL Request │ --> │ Filter Parser    │ --> │ Filter Function │
│ (with where)    │     │ (AST Generation) │     │ (TypeScript)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                            │
                                                            v
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ Client Updates  │ <-- │ Viewport Manager │ <-- │ Stream Filter   │
│ (with deletes)  │     │ (State Tracking) │     │ (RxJS)          │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

### Key Components

1. **Filter Parser**: Converts GraphQL where input to an executable filter function
2. **Viewport Manager**: Tracks filtered state per subscription
3. **Stream Filter**: Applies filters and generates appropriate events
4. **State Differ**: Detects when items enter/leave filter criteria

## State Transition Handling

### The Challenge

Simple RxJS filtering is insufficient because:
- Items that no longer match the filter must generate DELETE events
- Items that newly match the filter must generate INSERT events
- The client needs a consistent view of the filtered dataset

### Viewport Abstraction

Each subscription maintains a "viewport" - a filtered view of the data:

```typescript
interface SubscriptionViewport<T> {
  subscriptionId: string;
  filter: FilterFunction<T>;
  currentState: Map<string | number, T>; // What the client currently sees
  
  // Process an update and return events for the client
  processUpdate(event: RowUpdateEvent): ViewportEvent[];
}

interface ViewportEvent {
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  row: any;
  previousRow?: any; // For synthetic deletes
}
```

### State Transition Logic

```typescript
// When processing an update:
1. Apply filter to new row data
2. Check if row was previously in viewport
3. Generate appropriate event:
   - Was in viewport, still matches: UPDATE
   - Was in viewport, no longer matches: DELETE
   - Wasn't in viewport, now matches: INSERT
   - Wasn't in viewport, still doesn't match: (ignore)
```

## Technical Implementation

### 1. Filter Parser Implementation

```typescript
// Filter AST types
type FilterExpression = 
  | ComparisonExpression
  | LogicalExpression
  | NullCheckExpression;

interface ComparisonExpression {
  type: 'comparison';
  field: string;
  operator: '_eq' | '_gt' | '_lt' | '_gte' | '_lte' | '_in' | '_nin';
  value: any;
}

interface LogicalExpression {
  type: 'logical';
  operator: '_and' | '_or' | '_not';
  expressions: FilterExpression[];
}

// Parser function
function parseWhereClause(where: any): FilterExpression {
  // Recursively parse the where object into an AST
  // Handle nested logical operators
  // Validate field names against source schema
}

// Compiler function
function compileFilter<T>(ast: FilterExpression): FilterFunction<T> {
  switch (ast.type) {
    case 'comparison':
      return createComparisonFilter(ast);
    case 'logical':
      return createLogicalFilter(ast);
    // ...
  }
}
```

### 2. Viewport Manager

```typescript
class ViewportManager {
  private viewports = new Map<string, SubscriptionViewport>();
  
  createViewport(subscriptionId: string, filter: any): void {
    const filterFn = compileFilter(parseWhereClause(filter));
    const viewport = new SubscriptionViewport(subscriptionId, filterFn);
    
    // Initialize viewport with current snapshot filtered by filterFn
    const snapshot = this.databaseService.getSnapshot();
    viewport.initializeFromSnapshot(snapshot);
    
    this.viewports.set(subscriptionId, viewport);
  }
  
  processUpdate(event: RowUpdateEvent): Map<string, ViewportEvent[]> {
    const results = new Map<string, ViewportEvent[]>();
    
    for (const [subId, viewport] of this.viewports) {
      const events = viewport.processUpdate(event);
      if (events.length > 0) {
        results.set(subId, events);
      }
    }
    
    return results;
  }
}
```

### 3. Subscription Resolver Integration

```typescript
function createFilteredSubscriptionResolver(
  sourceName: string,
  streamingManager: DatabaseStreamingManagerService,
  viewportManager: ViewportManager
) {
  return {
    subscribe: (parent, args, context, info) => {
      const subscriptionId = context.connectionId; // From WebSocket context
      
      if (args.where) {
        viewportManager.createViewport(subscriptionId, args.where);
      }
      
      const observable = streamingManager.getUpdates(sourceName).pipe(
        // Process through viewport manager
        mergeMap((event: RowUpdateEvent) => {
          const viewportEvents = viewportManager.processUpdate(event);
          const subEvents = viewportEvents.get(subscriptionId) || [];
          
          return from(subEvents.map(ve => ({
            [sourceName]: {
              operation: ve.type,
              data: ve.row
            }
          })));
        })
      );
      
      return eachValueFrom(observable);
    }
  };
}
```

### 4. Complex Filter Examples

```typescript
// Date range filter
const dateRangeFilter = {
  created_at: {
    _and: [
      { _gte: "2024-01-01T00:00:00Z" },
      { _lt: "2024-02-01T00:00:00Z" }
    ]
  }
};

// Text search with OR
const textSearchFilter = {
  _or: [
    { name: { _ilike: "%john%" } },
    { email: { _ilike: "%john%" } }
  ]
};

// Nested conditions
const complexFilter = {
  _and: [
    { is_active: { _eq: true } },
    {
      _or: [
        { role: { _eq: "admin" } },
        {
          _and: [
            { role: { _eq: "user" } },
            { permissions: { _in: ["write", "delete"] } }
          ]
        }
      ]
    }
  ]
};
```

## Performance Considerations

### 1. Filter Compilation Caching

Cache compiled filter functions to avoid re-parsing:

```typescript
class FilterCache {
  private cache = new LRUCache<string, FilterFunction>({ max: 1000 });
  
  getOrCompile(where: any): FilterFunction {
    const key = JSON.stringify(where);
    let filter = this.cache.get(key);
    
    if (!filter) {
      filter = compileFilter(parseWhereClause(where));
      this.cache.set(key, filter);
    }
    
    return filter;
  }
}
```

### 2. Viewport State Management

- Maintain viewport state in memory for fast lookups
- Use efficient data structures (Maps) for O(1) access
- Consider memory limits for large datasets

### 3. Batch Processing

Process multiple viewport updates in batches:

```typescript
class BatchedViewportProcessor {
  private pendingUpdates: RowUpdateEvent[] = [];
  private batchTimer?: NodeJS.Timeout;
  
  scheduleUpdate(event: RowUpdateEvent) {
    this.pendingUpdates.push(event);
    
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.processBatch(), 10);
    }
  }
  
  private processBatch() {
    const updates = this.pendingUpdates;
    this.pendingUpdates = [];
    this.batchTimer = undefined;
    
    // Process all updates together
    const results = this.viewportManager.processBatch(updates);
    this.distributeResults(results);
  }
}
```

### 4. Subscription Multiplexing

Like Hasura, multiplex identical subscriptions:

```typescript
interface SubscriptionCohort {
  filter: any;
  subscriptionIds: Set<string>;
  viewport: SubscriptionViewport;
}

// Group subscriptions with identical filters
// Process once, distribute to all subscribers in cohort
```

## Future Enhancements

1. **SQL-Based Filtering**: For sources with direct SQL access, push filters to the database
2. **Incremental Diff Protocol**: Send only changed fields instead of full rows
3. **Filter Validation**: Validate filters against source schema at subscription time
4. **Performance Metrics**: Track filter execution time and viewport sizes
5. **Complex Type Support**: Handle JSON fields with nested filtering

## Implementation Phases

### Phase 1 - Core Operators (MVP)

The initial implementation should support the most commonly used operators:

**Comparison Operators**:
- `_eq`: Equal to
- `_neq`: Not equal to  
- `_gt`: Greater than
- `_lt`: Less than
- `_gte`: Greater than or equal to
- `_lte`: Less than or equal to

**List Operators**:
- `_in`: Value in array
- `_nin`: Value not in array

**Null Checks**:
- `_is_null`: Check if field is null (takes boolean)

**Logical Operators**:
- `_and`: All conditions must be true
- `_or`: At least one condition must be true
- `_not`: Negates the condition

**Text Operators** (PostgreSQL-specific):
- `_like`: SQL LIKE pattern matching
- `_ilike`: Case-insensitive LIKE

This covers approximately 80% of typical filtering use cases while keeping implementation complexity manageable.

### Phase 2 - Extended Operators (Future)

Once the core is stable, consider adding:

**Additional Text Operators**:
- `_nlike`: NOT LIKE
- `_nilike`: Case-insensitive NOT LIKE
- `_regex`: Regular expression matching
- `_nregex`: Negative regex matching

### Phase 3 - Advanced Features (Long-term)

**Not planned for initial releases**:
- Array operators (requires PostgreSQL array type support)
- JSON/JSONB operators (requires JSON column support)
- Nested relationship filtering (requires join support)
- Aggregation operators on relationships
- Geographic/spatial operators
- Full-text search operators

## Summary

The implementation requires:

1. **Filter Parser**: AST-based parser for GraphQL where clauses
2. **Viewport Manager**: Per-subscription state tracking with enter/exit logic
3. **Enhanced Subscription Resolvers**: Integration with viewport system
4. **Performance Optimizations**: Caching, batching, and multiplexing

This phased approach ensures that clients receive a consistent, filtered view of the data with proper INSERT/UPDATE/DELETE events as items move in and out of the filter criteria, while keeping the initial implementation scope manageable.

## Alternative Approaches: FINOS VUU and Genesis Data Server

### FINOS VUU Viewport Concept

FINOS VUU introduces a powerful "viewport" abstraction that tycostream can learn from:

1. **Viewport as First-Class Concept**: A viewport is a lightweight data structure managing client access to underlying data tables with a one-to-one relationship between server viewport and client subscription.

2. **Out-of-Band Processing**: Filter and sort calculations happen on a separate thread, ensuring the update path remains fast.

3. **Range-Based Loading**: VUU only sends data currently visible in the browser viewport, with the client sending range updates as users scroll.

4. **Server-Side Operations**: All filtering, sorting, grouping, and aggregation happen server-side, enabling handling of datasets up to 10 million rows.

Key implementation insights for tycostream:
- Consider implementing range-based data loading for large datasets
- Separate filter/sort processing from the main update stream
- Support server-side aggregations within viewports

### Genesis Data Server Approach

Genesis provides a different perspective on real-time filtering:

1. **Dual Filtering Model**:
   - **Client-side**: Using `CRITERIA_MATCH` with Groovy expressions
   - **Server-side**: Via `filter` blocks that cannot be circumvented

2. **Permission-Based Filtering**:
   - Permission codes restrict access to entire data sources
   - Row-level permissions through `auth` blocks
   - Dynamic authorization with external API integration

3. **View Size Management**:
   - Configurable `MAX_VIEW` limits
   - "Moving view" mode that replaces oldest rows when full

Key implementation insights for tycostream:
- Consider supporting both client and server-side filter definitions
- Implement view size limits for memory management
- Build foundation for permission-based filtering

## Future Considerations: Entitlements

While this document focuses on user-driven filtering via GraphQL `where` clauses, tycostream will eventually need to support entitlements/permissions. Some considerations for future implementation:

1. **Integration with Viewports**: Entitlements could be implemented as additional filters that combine with user filters
2. **Cohort Optimization**: Users with same entitlements could share viewport computation
3. **Audit Requirements**: Need to track what data each client receives for compliance

See the [ROADMAP](../ROADMAP.md) for more details on the audit trail functionality planned for production deployments.