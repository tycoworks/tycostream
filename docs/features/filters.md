# GraphQL Subscription Filters

## Overview

tycostream supports filtering for GraphQL subscriptions, allowing clients to subscribe to subsets of data using Hasura-compatible `where` clauses. This document describes the design and architecture of the filtering system.

## Table of Contents

1. [User Experience](#user-experience)
2. [Architectural Decision](#architectural-decision)
3. [The View Concept](#the-view-concept)
4. [Key Design Principles](#key-design-principles)
5. [Performance Optimizations](#performance-optimizations)
6. [Future Enhancements](#future-enhancements)

## User Experience

tycostream supports Hasura-compatible filtering, allowing users to filter subscriptions using a `where` argument with an intuitive syntax.

### Supported Operators

The implementation supports the most commonly used operators:

**Comparison**: `_eq`, `_neq`, `_gt`, `_lt`, `_gte`, `_lte`  
**List**: `_in`, `_nin`  
**Null**: `_is_null`  
**Logical**: `_and`, `_or`, `_not`

This covers ~80% of filtering use cases while keeping implementation simple.

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

There are two main approaches for implementing filtering, each with trade-offs:

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

### The Choice: Client-Side Filtering

tycostream implements Option 2 (client-side filtering) for the following reasons:

**Connection Efficiency**: Each unique filter combination would require a separate SUBSCRIBE connection to Materialize. With 1000 users having slightly different filters, this would create 1000 database connections, each with cursor and memory overhead.

**Row-Level Security**: Materialize has role-based access control (RBAC) for table/view permissions, but lacks row-level security (RLS) - the ability to filter which rows users can see based on their identity or context. Client-side filtering provides a foundation for implementing rules like "traders only see their own trades".

**Architectural Clarity**: Clear separation of concerns - Materialize handles computation and incremental view maintenance, while tycostream handles data distribution and user-specific filtering.

**Future Flexibility**: The filtering layer enables features beyond just `where` clauses, such as sorting, pagination, field masking, and rate limiting.

## The View Concept

With client-side filtering chosen, the system needs a way to maintain filtered subsets of the main cache for each subscription. This is where "Views" come in - lightweight filtered streams that track which rows from the main cache are visible to each client.

### Why Views?

Simple filtering (`stream.filter(predicate)`) doesn't work for subscriptions because:
- Items that stop matching the filter need DELETE events sent to clients
- Items that start matching the filter need INSERT events  
- Clients expect a consistent view of their filtered data

### View Architecture

The system follows a clean streaming architecture:

```
StreamingService (provides unified stream of snapshot + live events)
    ↓
ViewService (manages filtered views)
    ↓
View (stateful filtering transformer)
```

### State Transition Logic

When processing an event, the View:
1. Applies filter to row data
2. Checks if row was previously visible
3. Generates appropriate event:
   - Was visible, still matches → UPDATE (with only changed fields)
   - Was visible, no longer matches → DELETE  
   - Wasn't visible, now matches → INSERT
   - Wasn't visible, still doesn't match → (ignore)

## Key Design Principles

### Unified Streaming

Everything is treated as a stream of events. Snapshots are replayed as INSERT events through the same filtering pipeline as live updates. This ensures:
- Consistent filtering behavior
- Single code path to test and maintain
- Natural state building as events flow through

### Separation of Concerns

- **StreamingService**: Manages cache and provides unified event stream
- **ViewService**: Creates and manages filtered views with subscriber tracking
- **View**: Pure stream transformer that applies filter expressions

### Performance Optimizations

1. **Filter Compilation Caching**: Compiled filters are cached by expression string to avoid re-parsing
2. **View Sharing**: Multiple subscribers with the same filter share one View instance
3. **Field-Level Optimization**: Skip filter evaluation when changed fields don't affect filter predicates
4. **Efficient State Tracking**: Views store only primary keys, not full row copies

## Future Enhancements

1. **Additional Operators**: Text search (`_like`, `_ilike`), JSON/JSONB, arrays
2. **Filter Push-Down**: For simple filters, push to Materialize WHERE clauses
3. **Row-Level Security**: Add user context to filter expressions
4. **View Lifecycle Management**: Automatic cleanup of unused views when last subscriber disconnects
5. **Filter Query Optimization**: Analyze and optimize complex filter expressions