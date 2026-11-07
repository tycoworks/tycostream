# Timestamp Propagation and Deterministic IDs

## Overview

This document describes the foundational requirement for propagating source database timestamps (`mz_timestamp`) throughout tycostream's event pipeline. This enables deterministic event ID generation for idempotent processing and full event traceability.

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
2. **Timestamp Context**: Provides crucial context for event ordering and debugging
3. **Reliable Replay**: Replaying from database checkpoints generates identical IDs
4. **Event Tracing**: Full traceability from source database change to webhook delivery
5. **Testability**: Predictable IDs and timestamps simplify testing
6. **Future Capabilities**: Enables trigger persistence and resumption from last processed timestamp

## Requirements

### Functional Requirements

1. **Timestamp Propagation**: Database timestamps must flow through all layers:
   - Database → Source → View → Trigger → Webhook
   - Database → Source → View → GraphQL Subscription

2. **Deterministic Generation**: Event IDs must be deterministically generated from:
   - Trigger name
   - Row primary key
   - Source database timestamp

3. **GraphQL Exposure**: Source timestamps should be available in GraphQL subscriptions

4. **Preservation Through Features**: All features must preserve timestamp:
   - Calculated fields
   - Filters and views
   - Triggers
   - Future features

### Non-Functional Requirements

1. **Performance**: ID generation should not significantly impact latency
2. **Uniqueness**: IDs must be unique across all events
3. **Size**: IDs should be reasonably short for practical use

## Technical Approach

### Core Design Decision

**Timestamps are metadata, not data fields**. They are passed alongside events through the pipeline, not mixed into row data. This prevents:
- Accidental filtering on timestamps (semantically incorrect)
- Pollution of GraphQL schema with system fields
- Confusion about what is data vs metadata

### Timestamp Flow

#### 1. Database Layer

Materialize parser returns timestamp separately:

```typescript
// Parser returns tuple
parseRow(data: Buffer): [row: any, timestamp: bigint] {
  // Parse row data
  const row = { /* parsed fields */ };
  const timestamp = /* extract mz_timestamp */;
  return [row, timestamp];  // Keep separate
}
```

#### 2. Source Layer

Source maintains separation:

```typescript
// Source internally tracks both
private processUpdate(row: any, timestamp: bigint) {
  const event: RowUpdateEvent = {
    type: this.determineUpdateType(row),
    fields: this.getChangedFields(row),
    row: row  // No timestamp in row
  };

  // Emit both together but separate
  this.internalUpdates$.next([event, timestamp]);
}

// Public API returns both
getUpdates(): Observable<[RowUpdateEvent, bigint]> {
  return this.internalUpdates$;
}
```

#### 3. View Layer

Views pass through the tuple:

```typescript
class View {
  getUpdates(): Observable<[RowUpdateEvent, bigint]> {
    return this.source.getUpdates().pipe(
      filter(([event, timestamp]) => this.matches(event.row)),
      map(([event, timestamp]) => [event, timestamp])  // Preserve tuple
    );
  }
}
```

#### 4. GraphQL Layer

GraphQL resolver decides on exposure:

```typescript
// Option A: Add to wrapper (recommended)
const subscription = {
  operation: event.type,
  data: event.row,
  fields: Array.from(event.fields),
  ts_timestamp: timestamp.toString()  // Metadata, not in data
};

// Option B: Don't expose (simpler initially)
const subscription = {
  operation: event.type,
  data: event.row,
  fields: Array.from(event.fields)
  // timestamp used internally but not exposed
};
```

### Deterministic Event ID Generation

Trigger service receives timestamp as metadata:

```typescript
class TriggerService {
  processEvent(
    source: string,
    trigger: Trigger,
    event: RowUpdateEvent,
    timestamp: bigint  // Passed separately
  ): void {
    const eventId = this.generateEventId(
      trigger.name,
      event.row[this.primaryKey],
      timestamp
    );

    // Include in webhook
    const payload = {
      event_id: eventId,
      event_type: 'MATCH',
      trigger_name: trigger.name,
      timestamp: new Date().toISOString(),
      source_timestamp: timestamp.toString(),
      data: event.row
    };
  }

  private generateEventId(
    triggerName: string,
    primaryKey: any,
    timestamp: bigint
  ): string {
    const input = `${triggerName}:${primaryKey}:${timestamp}`;
    return crypto.createHash('sha256')
      .update(input)
      .digest('hex')
      .substring(0, 32);
  }
}
```

### API Contracts

#### Webhook Payload

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

#### GraphQL Subscription

```graphql
# Timestamp exposed as metadata, not a data field
type TradeUpdate {
  operation: RowOperation!
  data: Trade!  # ts_timestamp NOT in here
  fields: [String!]!
  ts_timestamp: String  # Optional metadata field
}

subscription {
  trades(where: {
    symbol: { _eq: "AAPL" }
    # Note: Cannot filter on ts_timestamp - it's not a data field
  }) {
    operation
    data { ... }
    fields
    ts_timestamp  # For deduplication only
  }
}
```

## Implementation Guidelines

### For New Features

Any new feature MUST:
1. Accept event/timestamp tuples: `[RowUpdateEvent, bigint]`
2. Pass timestamp as metadata, not in row data
3. Never add timestamp to SourceDefinition or columns
4. Document whether timestamp is exposed in API

### For Existing Features

When updating existing features:
1. Update signatures to accept `[event, timestamp]` tuples
2. Keep timestamp separate from row data
3. Update tests to verify timestamp flow
4. Ensure GraphQL schema doesn't expose timestamp for filtering

## Consumer Guidelines

### Webhook Consumers

Webhook consumers should implement deduplication:

```javascript
const processedEvents = new Set();

async function handleWebhook(payload) {
  // Check for duplicate
  if (processedEvents.has(payload.event_id)) {
    console.log(`Duplicate event: ${payload.event_id}`);
    return { status: 'already_processed' };
  }

  // Process event
  await processEvent(payload);

  // Mark as processed
  processedEvents.add(payload.event_id);

  // Cleanup old events after 24 hours
  setTimeout(() => processedEvents.delete(payload.event_id), 86400000);
}
```

### GraphQL Subscribers

GraphQL subscribers can use ts_timestamp for:
- **Deduplication**: Detect replayed events after tycostream restart
- **Ordering**: Verify event sequence
- **Debugging**: Correlate with database changes
- **NOT for filtering**: Timestamp filtering is semantically incorrect

Example deduplication:
```javascript
const seen = new Map(); // id -> last_timestamp

subscription.on('data', (update) => {
  const id = update.data.trade_id;
  const timestamp = update.ts_timestamp;

  if (seen.get(id) >= timestamp) {
    return; // Duplicate from restart
  }

  seen.set(id, timestamp);
  processUpdate(update);
});
```

## Testing Requirements

### Unit Tests
- Verify timestamp preservation through each layer
- Test deterministic ID generation consistency
- Validate timestamp format and type handling

### Integration Tests
- End-to-end timestamp flow from database to webhook
- End-to-end timestamp flow from database to GraphQL
- Replay scenarios generating identical IDs
- Deduplication behavior in consumers

### Performance Tests
- Measure ID generation overhead
- Verify no significant latency impact
- Test with high-volume event streams

## Implementation Plan

### Step 1: Pass Timestamp Through Source
**Goal**: Source already receives timestamp separately - just need to emit it

**Current State**:
- Materialize parser already returns `{ row, timestamp, updateType }`
- Source.processUpdate already receives `(row, timestamp, updateType)`
- Timestamp is tracked but not emitted

**Changes**:
- `src/view/source.ts`: Modify `internalUpdates$` to emit `[RowUpdateEvent, bigint]` tuples
- Change from emitting just `event` to emitting `[event, timestamp]`
- Update `getUpdates()` return type

**Testable**: Source emits tuples with timestamp preserved

---

### Step 2: Thread Through Pipeline
**Goal**: Pass timestamp as metadata through Source → View chain

**Changes**:
- `src/view/source.ts`:
  - Store and emit `[RowUpdateEvent, bigint]` tuples
  - Don't add timestamp to SourceDefinition
- `src/view/view.ts`: Pass tuples through filters unchanged
- Update method signatures throughout

**Testable**: Timestamp flows through pipeline without being in row data

---

### Step 3: Add Deterministic IDs to Triggers
**Goal**: Generate deterministic webhook event IDs

**Changes**:
- `src/services/trigger.service.ts`:
  - Receive timestamp with events
  - Generate SHA-256 hash from `trigger:primaryKey:timestamp`
  - Add to webhook payload as `event_id`
  - Include `source_timestamp` in payload
- Update trigger tests for deterministic IDs

**Testable**: Same inputs generate same IDs, webhooks include both IDs and timestamps

---

### Step 4: (Optional) Expose in GraphQL
**Goal**: Let subscribers deduplicate on restart

**Changes**:
- Add `ts_timestamp: String` to GraphQL update wrapper types (not data types!)
- Update subscription resolvers to include timestamp
- Document deduplication pattern
- Add example client code

**Testable**: GraphQL subscriptions include ts_timestamp in wrapper, not filterable

---

### Key Design Principles

1. **Timestamps are metadata**: Never add to row data or SourceDefinition
2. **No filtering**: Don't expose in GraphQL where expressions
3. **Explicit passing**: Use tuples to make timestamp flow visible
4. **Optional exposure**: GraphQL layer decides if/how to expose

## Future Enhancements

1. **Configurable ID Algorithm**: Allow choice of hash function
2. **ID Prefixes**: Add environment/region prefixes for multi-region deployments
3. **Compression**: Use base64 encoding for shorter IDs
4. **Batch Events**: Support deterministic IDs for batch webhook deliveries
5. **Checkpoint Recovery**: Use timestamps for resuming from last processed position