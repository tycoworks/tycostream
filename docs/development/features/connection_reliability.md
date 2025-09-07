# Connection Reliability and Event Tracking

This document explains tycostream's approach to connection reliability, event ordering, and the considerations around cursor-based resumption.

## Overview

tycostream provides real-time GraphQL subscriptions over mutable data sources (tables and materialized views in Materialize). Unlike append-only event streaming systems, tycostream handles data that can be inserted, updated, and deleted, which creates unique challenges for connection reliability and event tracking.

## Current Architecture

### Late Joiner Support

When a client subscribes to a tycostream source:

1. **Initial Snapshot**: Client receives the current state of all rows as INSERT events
2. **Live Updates**: Client then receives incremental changes (INSERT/UPDATE/DELETE) as they occur
3. **Stateless Connections**: Each new connection starts fresh with a full snapshot

This approach ensures clients always have a consistent view of the data, regardless of when they connect.

### Event Ordering

tycostream preserves the ordering provided by Materialize:
- Events are ordered by Materialize's internal timestamp
- Within a transaction, ordering is guaranteed
- Across distributed sources, ordering follows Materialize's consistency model

## Cursor-Based Resumption: Why It's Challenging

### The Fundamental Difference

Many streaming systems (like Hasura's streaming subscriptions or Kafka) support cursor-based resumption, where clients can:
- Disconnect and reconnect at a specific position
- Resume processing from where they left off
- Guarantee exactly-once delivery

However, these systems typically work with **append-only event logs**, not mutable datasets.

### Why Mutable Data Makes Cursors Complex

Consider this scenario:
1. Client receives snapshot at cursor position C1
2. Client disconnects
3. While disconnected:
   - Row A is updated from value X to Y
   - Row A is updated again from Y to Z
   - Row B is deleted
   - Row C is inserted
4. Client reconnects with cursor C1

**The Challenge**: tycostream's cache only stores the current state (Row A=Z, Row B=gone, Row C=exists). It doesn't maintain a history of all intermediate changes.

### Comparison with Other Systems

| System | Data Model | Cursor Support | Trade-offs |
|--------|-----------|----------------|------------|
| **Hasura Streaming Subscriptions** | Append-only tables with triggers | Full cursor support with exactly-once delivery | Only works with event tables, not regular tables or views |
| **Hasura Live Queries** | Any table/view | No cursor support - full refresh on reconnect | Simple but potentially expensive for large datasets |
| **Kafka** | Append-only log | Full cursor support with configurable retention | Requires separate event streaming infrastructure |
| **Materialize SUBSCRIBE** | Any source/view | Full cursor support via AS OF timestamp | Requires history retention configuration |
| **Genesis Data Server** | Any table | No cursor support - full snapshot on reconnect | Similar to tycostream approach |
| **Vuu (FINOS)** | Any table | Version-based acks but no resume | Eventually consistent aggregates |
| **GraphQL Subscriptions** | Any | No standard for reliability | Stateless, no delivery guarantees |
| **tycostream** | Mutable tables/views | Snapshot on connect | Simple, works with any Materialize source |

### Note on Materialize's Cursor Capabilities

Materialize's `SUBSCRIBE AS OF` feature enables cursor-based resumption, which tycostream will use internally for reliability. When the connection between tycostream and Materialize drops, tycostream can resume its subscription from the last known timestamp without losing any events. This ensures data integrity at the source level, even though individual clients still receive snapshots on reconnection.

### GraphQL Subscription Limitations

It's important to understand that GraphQL subscriptions were not designed with reliable delivery in mind:

- **No delivery guarantees**: The GraphQL specification doesn't include exactly-once or at-least-once semantics
- **Stateless resolvers**: No built-in mechanism to track what data was sent to which client
- **No acknowledgments**: One-way data flow prevents clients from confirming receipt
- **No standard resume protocol**: Each implementation handles reconnection differently

This is why most GraphQL subscription implementations, including tycostream, use snapshot-on-reconnect patterns. The protocol was designed for "live state" use cases (like collaborative editing) rather than event streaming with guaranteed delivery.

## Practical Patterns for Reliability

### 1. Client-Side Event Deduplication

While tycostream doesn't provide cursors, clients can implement deduplication:

```typescript
// Track seen events by primary key + timestamp
const seenEvents = new Map<string, bigint>();

subscription.on('data', (event) => {
  const key = `${event.data.id}-${event.timestamp}`;
  if (!seenEvents.has(key)) {
    seenEvents.set(key, event.timestamp);
    processEvent(event);
  }
});
```

### 2. Building Event Sourcing on Top

For use cases requiring event history, consider:

1. **Materialize as Event Processor**: 
   - Source writes to an append-only event table
   - Materialize view aggregates events into current state
   - tycostream streams the aggregated view

2. **Dual Subscription Pattern**:
   - Subscribe to both the event stream and current state
   - Use events for audit/history
   - Use state for current data

### 3. Handling Reconnections

Clients should implement reconnection logic that accounts for receiving a fresh snapshot:

```typescript
let isReconnection = false;

subscription.on('connect', () => {
  if (isReconnection) {
    // Clear local state - we'll receive a new snapshot
    clearLocalCache();
    console.log('Reconnected - receiving fresh snapshot');
  }
  isReconnection = true;
});
```

## Future Possibilities

### Near-term Improvements (Planned)

1. **Connection State Tracking**: Clients can detect snapshot vs incremental phase
2. **Recent Event Buffer**: Best-effort replay of recent events (e.g., last 5 minutes)
3. **Event Sequence Numbers**: Help clients detect gaps in event stream

### Potential Long-term Enhancements

1. **Checkpoint Support**: Allow clients to request "changes since timestamp X" if within buffer window
2. **Append-Only Mode**: Special handling for append-only sources where cursor support is feasible
3. **External Event Log Integration**: Optional integration with Kafka/Pulsar for full event history

## Design Philosophy

tycostream optimizes for:
- **Simplicity**: No complex state management required
- **Consistency**: Clients always have a complete, consistent view
- **Compatibility**: Works with any Materialize source (tables, views, joins)

This is a different philosophy from event streaming systems that optimize for:
- **Resumability**: At the cost of requiring append-only semantics
- **History**: At the cost of additional storage and complexity

## When to Use What

### Use tycostream when:
- You need real-time updates to mutable data
- Clients can handle receiving snapshots on reconnect
- You want to leverage Materialize's view computation capabilities
- Simplicity and consistency are more important than resumability

### Consider alternatives when:
- You need guaranteed exactly-once processing across disconnections
- You must maintain full event history
- Your data is naturally append-only (logs, events, metrics)
- Cursor-based resumption is a hard requirement

## Implementation Roadmap

This document serves as both research findings and implementation guide. The work is divided into phases:

### Phase 1: Research & Current State (Complete)
- ✅ Analyzed competing systems and their trade-offs
- ✅ Documented GraphQL protocol limitations  
- ✅ Established tycostream's position in the ecosystem
- ✅ Identified Materialize's cursor capabilities for internal use

### Phase 2: Design & Implementation (Upcoming)

Based on this research, the recommended implementation approach:

#### 2.1 tycostream → Materialize Reliability
- Implement cursor-based resume using `SUBSCRIBE AS OF`
- Track last processed `mz_timestamp` 
- Configure history retention on Materialize sources
- Add exponential backoff for reconnection

#### 2.2 Client-Facing Improvements
- Add subscription lifecycle events (snapshot-start, snapshot-complete, live)
- Implement time-bounded replay buffer for recent events
- Add connection health monitoring and status events
- Provide clear error messages with actionable information

#### 2.3 Possible Future Enhancements
- View-level event logs (only if cursor support for filtered subscriptions becomes necessary)
- Integration with external event stores (if full history requirements emerge)
- Client SDK with built-in reliability patterns

## Conclusion

tycostream's approach to connection reliability reflects its focus on streaming mutable, computed data rather than append-only events. While this means cursor-based resumption isn't feasible with the current architecture, it enables powerful use cases that event streaming systems cannot handle, such as real-time materialized views with complex joins and aggregations.

For applications requiring both capabilities, consider a hybrid approach: use tycostream for real-time state and a separate event streaming system for append-only audit logs.