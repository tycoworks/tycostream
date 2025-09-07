# Production Triggers

## Overview

Making triggers and webhooks production-ready with reliability, manageability, and failure handling. This document covers the design and implementation of production trigger features for tycostream.

## Features to Implement

### Reliability
- **At-least-once delivery** with exponential backoff
- **Dead letter queue** for failed webhooks  
- **Idempotency support** via deterministic event IDs
- **Error webhooks** for stream disconnection events

### Manageability
- **Enable/disable triggers** without deletion
- **Trigger persistence** (survive restarts)
- **List trigger state** (enabled/disabled, last fired, match count)
- **Trigger metadata** (created_at, updated_at, created_by)
- **Query matched rows** for debugging

## Deterministic Event IDs

> This section details the idempotency support feature. Other reliability features will be documented as they are designed.

## Motivation

### Current State

tycostream currently:
- Generates random UUIDs for webhook event IDs
- Does not propagate source timestamps through the event pipeline
- Lacks correlation between webhook events and their originating database timestamps

```typescript
const payload = {
  event_id: randomUUID(),  // Random, non-deterministic
  event_type: 'MATCH',
  trigger_name: 'large_trade_alert',
  timestamp: new Date().toISOString(),  // Only send time, not source time
  data: { ... }
};
```

### Problems

1. **No Idempotency**: If webhooks are retried or replayed, receivers cannot detect duplicates
2. **Lost Events**: If tycostream restarts and replays from a checkpoint, new random IDs will be generated
3. **No Traceability**: Cannot correlate events back to specific database timestamps for debugging or auditing
4. **Testing Challenges**: Non-deterministic IDs make integration testing harder
5. **Missing Context**: Downstream systems don't know when the source data actually changed

### Benefits

1. **Deterministic IDs**: Enable idempotent processing and reliable deduplication
2. **Timestamp Propagation**: Provides crucial context for event ordering and debugging
3. **Reliable Replay**: Replaying from database checkpoints generates identical IDs
4. **Event Tracing**: Full traceability from source database change to webhook delivery
5. **Testability**: Predictable IDs and timestamps simplify testing
6. **Future Capabilities**: Enables trigger persistence and resumption from last processed timestamp

## Requirements

### Functional Requirements

1. **Deterministic Generation**: Event IDs must be deterministically generated from:
   - Trigger name
   - Row primary key
   - Source database timestamp
   
2. **Timestamp Propagation**: Database timestamps must flow through all layers:
   - Database → Source → View → Trigger → Webhook
   
3. **Clean Implementation**: No backward compatibility needed (pre-release software)

4. **GraphQL Exposure**: Source timestamps should be available in GraphQL subscriptions

### Non-Functional Requirements

1. **Performance**: ID generation should not significantly impact latency
2. **Uniqueness**: IDs must be unique across all events
3. **Size**: IDs should be reasonably short for practical use

## Technical Approach

### Event ID Generation

Generate deterministic IDs using SHA-256 hash:

```typescript
private generateEventId(
  triggerName: string,
  primaryKey: any,
  timestamp: bigint
): string {
  const input = `${triggerName}:${primaryKey}:${timestamp}`;
  return crypto.createHash('sha256')
    .update(input)
    .digest('hex')
    .substring(0, 32); // 128-bit hex string
}
```

### Timestamp Propagation

#### 1. Update Core Data Structures

```typescript
// Add timestamp to RowUpdateEvent
export interface RowUpdateEvent {
  type: RowUpdateType;
  fields: Set<string>;
  row: Record<string, any>;
  timestamp: bigint;  // NEW - from database
}
```

#### 2. Modify Source Layer

```typescript
// In Source.getUpdates()
return this.internalUpdates$.pipe(
  map(([event, timestamp]) => ({
    ...event,
    timestamp  // Include timestamp in output
  }))
);
```

#### 3. Update View Layer

Pass timestamp through View and Filter unchanged.

#### 4. Enhance Trigger Service

```typescript
private async processEvent(
  source: string, 
  trigger: Trigger, 
  event: RowUpdateEvent
): Promise<void> {
  const eventId = this.generateEventId(
    trigger.name,
    event.row[this.primaryKeyField],
    event.timestamp
  );
  
  await this.sendWebhook(
    trigger.webhook,
    eventType,
    trigger.name,
    event.row,
    eventId,
    event.timestamp
  );
}
```

### Webhook Payload Structure

```json
{
  "event_id": "a3f2b8c9d4e5f6a7",  // Deterministic hash
  "event_type": "MATCH",
  "trigger_name": "large_trade_alert",
  "timestamp": "2024-01-15T10:30:45.123Z",  // Send time
  "source_timestamp": "1705316445123456789",  // Database timestamp
  "data": {
    "trade_id": 123,
    "symbol": "AAPL",
    "quantity": 15000
  }
}
```

### GraphQL Schema Updates

```graphql
type TradeUpdate {
  operation: RowOperation!
  data: Trade!
  fields: [String!]!
  source_timestamp: String!  # NEW - database timestamp
}

subscription {
  trades(where: { symbol: { _eq: "AAPL" } }) {
    operation
    data { ... }
    fields
    source_timestamp  # Available for correlation
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (Breaking Changes)
1. Add timestamp field to RowUpdateEvent interface
2. Update Source to include timestamp in events
3. Update View to pass through timestamp
4. Update all tests for new data structure

### Phase 2: Trigger Enhancement
1. Modify TriggerService to receive timestamps
2. Implement deterministic ID generation
3. Add source_timestamp to webhook payloads
4. Update trigger tests

### Phase 3: GraphQL Exposure
1. Add source_timestamp to GraphQL schema
2. Update subscription resolvers
3. Add GraphQL tests

### Phase 4: Documentation & Migration
1. Update API documentation
2. Create migration guide for webhook consumers
3. Add example webhook handlers showing deduplication

## Migration Strategy

### Migration Steps

Since tycostream is still in development, we can make this change directly without maintaining backward compatibility:

1. **Deploy**: Update to deterministic IDs in a single release
2. **Document**: Update all API documentation and examples
3. **Notify**: Inform early adopters of the change

### Consumer Guidelines

Webhook consumers should:
1. Use event_id for deduplication
2. Store processed event_ids (with TTL for cleanup)
3. Handle replay scenarios gracefully

Example deduplication:
```javascript
const processedEvents = new Set();

async function handleWebhook(payload) {
  if (processedEvents.has(payload.event_id)) {
    console.log(`Duplicate event: ${payload.event_id}`);
    return { status: 'already_processed' };
  }
  
  // Process event...
  processedEvents.add(payload.event_id);
  
  // Cleanup old events after 24 hours
  setTimeout(() => processedEvents.delete(payload.event_id), 86400000);
}
```

## Testing Strategy

### Unit Tests
- Verify deterministic ID generation consistency
- Test timestamp propagation through layers
- Validate backward compatibility

### Integration Tests
- End-to-end timestamp flow from database to webhook
- Replay scenarios generating identical IDs
- Deduplication behavior in consumers

### Performance Tests
- Measure ID generation overhead
- Verify no significant latency impact
- Test with high-volume event streams

## Future Enhancements

1. **Configurable ID Algorithm**: Allow choice of hash function
2. **ID Prefixes**: Add environment/region prefixes for multi-region deployments
3. **Compression**: Use base64 encoding for shorter IDs
4. **Batch Events**: Support deterministic IDs for batch webhook deliveries