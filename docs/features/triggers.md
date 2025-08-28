# Real-Time Triggers

## Table of Contents

1. [Overview](#overview)
2. [Use Case Examples](#use-case-examples)
3. [Requirements](#requirements)
4. [Comparison with Existing Systems](#comparison-with-existing-systems)
5. [Architecture](#architecture)
6. [Implementation](#implementation)
7. [Demo Application](#demo-application)

## Overview

tycostream will support event triggers that fire webhooks when data matches specific conditions, enabling integration with external systems and workflow automation. This document describes the design and implementation approach.

## Examples

* Large Trade Monitoring: A bank's compliance team wants to be notified by email whenever any single trade exceeds 10,000 shares.
* Risk Position Management: A risk manager wants an alert generated when a net position exceeds $10,000, then cleared once it drops back below $9,500. Different thresholds prevent a position bouncing between $9,999 and $10,001 from firing alerts repeatedly.


## Requirements

### Core Concepts

Triggers monitor data for condition state changes:

- **MATCH event**: Fired when a condition becomes true (was previously false)
- **UNMATCH event**: Fired when a condition becomes false (was previously true)

For example, when monitoring if a position exceeds $10,000:
- Position goes from $9,000 to $11,000 → MATCH event fires
- Position drops from $11,000 to $8,000 → UNMATCH event fires

You can configure:
- **Same threshold**: Use one condition for both match and unmatch (simple monitoring)
- **Different thresholds**: Use separate conditions to prevent oscillation (e.g., match at $10,000, unmatch at $9,500)

### Trigger Configuration

**Simple Trigger** (same condition for match/unmatch):
```json
{
  "name": "large_trade_alert",  # Must be unique
  "source": "trades",
  "match": {
    "condition": {
      "symbol": { "_eq": "AAPL" },
      "quantity": { "_gt": 10000 }
    },
    "webhook": "https://compliance-api/large-trade"
  }
}
```

When only `match` is specified, the same condition is used for both match and unmatch events.

**Trigger with Different Match/Unmatch Conditions**:
```json
{
  "name": "risk_position_alert",  # Must be unique
  "source": "positions",
  "match": {
    "condition": { "net_position": { "_gt": 10000 } },
    "webhook": "https://api/risk-alert"
  },
  "unmatch": {
    "condition": { "net_position": { "_lte": 9500 } },
    "webhook": "https://api/all-clear"
  }
}
```

### API Endpoints

**Create trigger**:
```json
POST /triggers
{
  "name": "large_trade_alert",  # Must be unique
  "source": "trades",
  "match": {
    "condition": {
      "symbol": { "_eq": "AAPL" },
      "quantity": { "_gt": 10000 }
    },
    "webhook": "https://my-app.com/alert"
  }
}
```

**Delete trigger**:
```
DELETE /triggers/large_trade_alert
```

**List triggers**:
```
GET /triggers
```

**Get specific trigger**:
```
GET /triggers/large_trade_alert
```

### Webhook Payload

Webhooks receive a POST request with the full row data:

```json
{
  "event_type": "MATCH",
  "trigger_name": "risk_position_alert",
  "timestamp": "2024-01-15T10:31:45.123Z",
  "data": {
    "position_id": "ABC",
    "symbol": "AAPL",
    "net_position": 10250,
    "trader": "john",
    "last_updated": "2024-01-15T10:31:45.000Z"
  }
}
```

The payload includes:
- `event_type`: Either "MATCH" or "UNMATCH"
- `trigger_name`: Name of the trigger that fired
- `timestamp`: When the trigger fired (ISO 8601)
- `data`: Complete row data from the source

All fields from the source row are included in the data object. The webhook endpoint should validate and extract only the fields it needs.

## Comparison with Existing Systems

**Hasura Event Triggers**
- Only fire on database table operations (INSERT/UPDATE/DELETE)
- No support for conditional filtering with `where` clauses
- Can't monitor streaming views or computed data
- No built-in deduplication

**AWS EventBridge / Google Eventarc**
- Require events to be pushed to them first
- Don't consume streaming SQL views or GraphQL subscriptions
- Would need custom Lambda to bridge Materialize → EventBridge

**Zapier / IFTTT / Make**
- No support for GraphQL subscriptions
- Can't connect directly to streaming data sources
- Would require custom webhook adapter

**Apache Flink / Kafka Connect**
- Heavyweight solutions requiring significant infrastructure
- Complex configuration and deployment
- Overkill for simple webhook delivery

## Architecture

### Triggers as Peers to GraphQL

Triggers will be implemented as a peer to the GraphQL engine, consuming directly from the streaming core:

```
                    ┌─────────────────┐
                    │  Materialize    │
                    │     Views       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │  Streaming Core │
                    │  (tycostream)   │
                    └────────┬────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
       ┌────────▼────────┐      ┌────────▼────────┐
       │ GraphQL Engine  │      │ Trigger Engine  │
       │                 │      │                 │
       └────────┬────────┘      └────────┬────────┘
                │                         │
       ┌────────▼────────┐      ┌────────▼────────┐
       │   WebSocket     │      │    Webhooks     │
       │   (UI Clients)  │      │  (HTTP POST)    │
       └─────────────────┘      └─────────────────┘
```

Both GraphQL and Triggers:
- Use the same filtering logic
- Consume the same streams  
- Run in parallel without interference
- Lazy-load sources on first use
- Share the same View objects from `ViewService`

### Runtime Storage

Triggers are stored in a simple in-memory Map (consistent with tycostream's existing cache approach):

- **In-memory Map**: Same pattern as existing cache implementation
- **No persistence**: Triggers lost on restart (by design)
- **Apps re-register on startup**: Calling applications are responsible for re-creating their triggers

This keeps tycostream truly stateless - it's just a router between streams and webhooks.

## Implementation

### Implementation Steps

1. **Extend views with match/unmatch logic (internal foundation)** ✅
   - ✅ Move filter compilation (`buildFilter`) from `src/graphql/filters.ts` to shared module for reuse
   - ✅ Modify View class to accept optional separate match/unmatch conditions
   - ✅ Update visibility logic: row exits only when unmatch condition is met (not when match condition becomes false)
   - ✅ Keep this internal - GraphQL continues using simple `where` clauses
   - ✅ Test the new exit behavior with unit tests

2. **Trigger module and API** ✅
   - ✅ Create trigger module with controller and service
   - ✅ Add REST endpoints for trigger management (NestJS controllers)
   - ✅ Support separate webhooks for match/unmatch events
   - ✅ In-memory trigger registry

### Architecture Discovery (During Step 3 Implementation)

During Step 3 implementation, we discovered that View and Trigger have fundamentally different requirements:

**View (for GraphQL subscriptions)**
- Shows "what's currently visible through a filter"
- Needs snapshot to establish initial state
- Uses symmetric filters (WHERE clauses)
- Each client gets own instance
- Emits INSERT/UPDATE/DELETE based on view membership

**TriggerHandler (for webhooks)**
- Detects "state transitions" (crossing thresholds)
- Skips snapshot (don't fire on existing data)
- Uses asymmetric conditions (match/unmatch for hysteresis)
- Shared across all triggers for a source
- Emits MATCH/UNMATCH events

3. **Refactor to separate concerns** (New approach)
   - Revert View changes - remove Filter/asymmetric conditions
   - Move View to graphql module (it's GraphQL-specific)
   - Add `skipSnapshot` parameter to Source.getUpdates()
   - Create TriggerHandler class for trigger-specific logic

4. **Connect triggers to streaming core** (Updated)
   - TriggerHandler subscribes with skipSnapshot=true
   - One TriggerHandler per source (handles all triggers)
   - Track match state per row per trigger
   - Fire webhooks using @nestjs/axios
   - For MVP: log webhook errors and skip (no retries, no process exit)

5. **Demo implementation**
   - Add simple webhook receiver (10-line Express server)
   - Create alerts table in Materialize
   - Update demo UI with trigger management panel
   - Show live audit trail of triggered/cleared events
   - Integration tests

## Demo Application

The existing position monitoring demo will be extended to showcase trigger functionality.

### Trigger Management UI

The demo will add a trigger management panel showing:
- Active trigger definitions
- Create/edit/delete triggers
- Test webhook endpoints

### Audit Trail Implementation

To showcase the trigger functionality, the demo includes a complete audit trail:

1. **Webhook Receiver**: Simple Express server that receives webhook POSTs
2. **Alerts Table in Materialize**:
   ```sql
   CREATE TABLE alerts (
     id SERIAL,
     timestamp TIMESTAMPTZ DEFAULT NOW(),
     trigger_name TEXT,
     event_type TEXT,  -- 'TRIGGERED' or 'CLEARED'
     data JSONB,
     PRIMARY KEY (id)
   );
   ```

3. **Live Audit View**: The demo UI subscribes to the alerts table, showing:
   ```
   Recent Alert Activity:
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   10:31:45  risk_position  TRIGGERED   position: ABC, value: 10,250
   10:33:12  risk_position  CLEARED     position: ABC, value: 9,450  
   10:35:22  large_trade    TRIGGERED   trade: 123, quantity: 15,000
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ```

This creates a complete loop: Materialize data → tycostream trigger → webhook → insert into alerts → tycostream subscription → UI update.