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
```graphql
mutation {
  create_trades_trigger(
    name: "large_trade_alert"
    webhook: "https://compliance-api/webhook"
    match: {
      symbol: { _eq: "AAPL" }
      quantity: { _gt: 10000 }
    }
  ) {
    name
    source
    webhook
    match
    unmatch
  }
}
```

When only `match` is specified, the inverse condition (!match) is automatically used for unmatch events.

**Trigger with Different Match/Unmatch Conditions** (hysteresis):
```graphql
mutation {
  create_positions_trigger(
    name: "risk_position_alert"
    webhook: "https://api/webhook"
    match: { net_position: { _gt: 10000 } }
    unmatch: { net_position: { _lte: 9500 } }
  ) {
    name
    source
    webhook
    match
    unmatch
  }
}
```

### Webhook Payload

Webhooks receive a POST request with the event type and full row data:

```json
{
  "event_type": "MATCH",  // or "UNMATCH"
  "trigger_name": "large_trade_alert",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "id": 12345,
    "symbol": "AAPL",
    "quantity": 15000,
    "price": 150.50
  }
}
```

The payload includes:
- `event_type`: Either "MATCH" or "UNMATCH"
- `trigger_name`: Name of the trigger that fired
- `timestamp`: When the trigger fired (ISO 8601)
- `data`: Complete row data from the source

### GraphQL API

**Create trigger** (source-specific for type safety):
```graphql
mutation {
  create_trades_trigger(
    name: "large_trade_alert"
    webhook: "https://my-app.com/webhook"
    match: {
      symbol: { _eq: "AAPL" }
      quantity: { _gt: 10000 }
    }
  ) {
    name
    source
    webhook
    match
    unmatch
  }
}
```

**Delete trigger** (source-specific):
```graphql
mutation {
  delete_trades_trigger(name: "large_trade_alert") {
    name
    source
    webhook
  }
}
```

**Get specific trigger** (source-specific for typed conditions):
```graphql
query {
  trades_trigger(name: "large_trade_alert") {
    name
    source
    webhook
    match {
      symbol { _eq }
      quantity { _gt }
    }
    unmatch
  }
}
```

**List all triggers for a source** (source-specific):
```graphql
query {
  trades_triggers {
    name
    webhook
    match {
      symbol { _eq }
      quantity { _gt }
    }
    unmatch
  }
}
```


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

### Unified GraphQL API

Triggers are implemented as GraphQL mutations, living alongside subscriptions in a unified API:

```
                    ┌─────────────────┐
                    │  Materialize    │
                    │     Views       │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │     Source      │
                    │  (enrichment)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │      View       │
                    │   (filtering)   │
                    └────────┬────────┘
                             │
                    ┌────────▼────────┐
                    │   GraphQL API   │
                    ├─────────────────┤
                    │ • Subscriptions │ ──► WebSocket clients
                    │ • Triggers      │ ──► Webhook endpoints
                    └─────────────────┘
```

The View abstraction provides:
- Filtered event streams with INSERT/UPDATE/DELETE semantics
- Support for asymmetric match/unmatch conditions
- Optional delta updates (changed fields only) for network efficiency
- Consistent event delivery to all consumers

Both subscriptions and triggers use View events:
- **Subscriptions**: Stream to WebSocket clients with INSERT/UPDATE/DELETE
- **Triggers**: POST to webhooks with MATCH (INSERT) and UNMATCH (DELETE)

### Runtime Storage

Triggers are stored in a nested in-memory Map structure (consistent with tycostream's existing cache approach):

- **In-memory Map**: Source → Name → Trigger (names are scoped by source)
- **No persistence**: Triggers lost on restart (by design)
- **Apps re-register on startup**: Calling applications are responsible for re-creating their triggers

This keeps tycostream truly stateless - it's just a router between streams and webhooks.

## Implementation

### Implementation Plan

The implementation is divided into four main phases:

#### Phase 1: View Layer Enhancement ✅

Extend the View abstraction to support asymmetric filtering and delta updates:

1. **Add match/unmatch filter support** (`src/view/view.ts`)
   - Support separate match and unmatch conditions
   - Default unmatch to !match when not specified
   - Track row visibility based on condition state

2. **Implement delta updates** (`src/view/view.ts`)
   - Track field changes between events
   - Optional mode for network efficiency
   - GraphQL uses this to minimize payload size

3. **Event enrichment** (`src/view/source.ts`)
   - Ensure all events have full row data
   - Cache rows for enriching partial updates/deletes
   - Database-agnostic approach

#### Phase 2: API Module Enhancement ✅

Enhance the API module to support triggers alongside subscriptions:

1. **Module organization** (`src/api/`)
   - Unified API layer for all external interfaces
   - GraphQL subscriptions and trigger mutations together
   - Shared utilities and types

2. **Update GraphQL subscriptions** (`src/api/subscription.resolver.ts`)
   - Use delta updates for efficiency
   - Map View events to GraphQL operations
   - Handle field filtering for compatibility

#### Phase 3: Trigger Implementation

Implement the trigger system using GraphQL mutations and the View abstraction:

1. **GraphQL Schema** (`src/api/schema.ts`)
   - Generate source-specific mutations: `create_${source}_trigger`/`delete_${source}_trigger`
   - Generate source-specific queries: `${source}_trigger` (get one), `${source}_triggers` (list for source)
   - Generate source-specific list queries: `${source}_triggers` (list all for that source)
   - Generate source-specific types: `${Source}Trigger` with typed match/unmatch fields

2. **Trigger Resolvers** (`src/api/trigger.resolver.ts`)
   - Mutation resolvers for create/delete operations
   - Query resolvers for list/get operations
   - Integration with TriggerService

3. **Trigger Service** (`src/api/trigger.service.ts`)
   - Manages trigger configurations in memory
   - Creates View subscriptions for each trigger
   - Maps View events to webhook calls

4. **Webhook delivery** (`src/api/trigger.service.ts`)
   - HTTP POST with full row data using NestJS HttpModule (axios)
   - Retry logic for failures
   - Async processing to avoid blocking

#### Phase 4: Testing and Documentation

Complete the implementation with comprehensive testing:

1. **Unit tests**
   - View match/unmatch logic
   - Trigger service webhook firing
   - API endpoint validation

2. **Integration tests**
   - End-to-end trigger flow
   - Concurrent trigger handling
   - Error recovery scenarios

3. **Demo application**
   - Trigger management UI
   - Live webhook monitoring
   - Example use cases

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