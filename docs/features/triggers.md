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
  "name": "large_trade_alert",
  "source": "trades",
  "webhook": "https://compliance-api/webhook",
  "match": {
    "symbol": { "_eq": "AAPL" },
    "quantity": { "_gt": 10000 }
  }
}
```

When only `match` is specified, the inverse condition (!match) is automatically used for unmatch events.

**Trigger with Different Match/Unmatch Conditions** (hysteresis):
```json
{
  "name": "risk_position_alert",
  "source": "positions",
  "webhook": "https://api/webhook",
  "match": { "net_position": { "_gt": 10000 } },
  "unmatch": { "net_position": { "_lte": 9500 } }
}
```

### Webhook Payload

The webhook receives a JSON payload with the event type and row data:

```json
{
  "event": "MATCH",  // or "UNMATCH"
  "trigger": "large_trade_alert",
  "timestamp": "2024-01-15T10:30:00Z",
  "data": {
    "id": 12345,
    "symbol": "AAPL",
    "quantity": 15000,
    "price": 150.50
  }
}
```

### API Endpoints

**Create trigger**:
```json
POST /triggers
{
  "name": "large_trade_alert",
  "source": "trades",
  "webhook": "https://my-app.com/webhook",
  "match": {
    "symbol": { "_eq": "AAPL" },
    "quantity": { "_gt": 10000 }
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
   - ✅ Support single webhook URL (simplified from original design)
   - ✅ In-memory trigger registry

### Revised Architecture (Simplified Approach)

After implementing the initial design, we discovered a simpler, more elegant architecture:

**Key Insight**: Views already provide the right abstraction - they track what's "in view" and emit INSERT/UPDATE/DELETE events. Triggers are just Views where INSERT means "matched" and DELETE means "unmatched". No new abstractions needed.

**New Architecture**:
```
streaming/
  ├── Source (raw event stream)
  ├── View (tracks what's in filtered set, emits INSERT/UPDATE/DELETE)
  └── Types, Filter, etc.

api/
  ├── GraphQL subscriptions (uses View events, filters fields as needed)
  └── Webhook triggers (uses View events, fires on INSERT/DELETE)
```

**Benefits**:
- No new abstractions or event types
- View remains a simple filtered stream
- Each API layer interprets events as needed
- Minimal code changes

### Implementation Plan

#### Phase 1: Clean up View

1. **Remove GraphQL-specific field filtering** (`src/streaming/view.ts`)
   - Keep INSERT/UPDATE/DELETE event types
   - Always include all fields in the event
   - Remove the logic that filters fields for DELETE events
   - Let each API layer decide what fields it needs

2. **Keep ViewService as-is** (`src/streaming/view.service.ts`)
   - No changes needed
   - Continue creating View instances per subscription

3. **View continues to track visibility**
   - Keep the visibleKeys Set
   - Keep match/unmatch evaluation logic
   - Support both symmetric (match only) and asymmetric (match/unmatch) conditions

#### Phase 2: Reorganize API Layer

4. **Rename graphql directory to api** (`src/graphql/` → `src/api/`)
   - Keep flat structure - no subdirectories
   - All GraphQL and trigger files at same level
   - Update imports across the codebase

5. **Update GraphQL subscriptions** (`src/api/subscriptions.ts`)
   - Add field filtering logic that was removed from View
   - For DELETE events, only send primary key field
   - For INSERT events, send all fields
   - For UPDATE events, send changed fields

#### Phase 3: Implement Trigger API

6. **Move trigger REST endpoints to api** (`src/trigger/` → `src/api/`)
   - Move `trigger.controller.ts` and `trigger.dto.ts` to api/
   - Delete entire `src/trigger/` directory after moving files
   - Trigger module gets merged into api.module.ts

7. **Create WebhookService** (`src/api/webhook.service.ts`)
   - Manages trigger configurations (in-memory Map):
     ```typescript
     private triggers = new Map<string, TriggerConfig>();
     private subscriptions = new Map<string, Subscription>();
     ```
   - For each trigger:
     - Creates a View via ViewService with skipSnapshot=true
     - Subscribes to View events
     - Maps INSERT → MATCH webhook, DELETE → UNMATCH webhook
     - Ignores UPDATE events
   - Stores both trigger config and subscription
   - Handles webhook failures (log and continue)

8. **Update TriggerController** (`src/api/trigger.controller.ts`)
   - Inject WebhookService instead of TriggerService
   - CRUD operations manage trigger registry:
     - POST /triggers - Creates View and subscription
     - DELETE /triggers/:name - Disposes subscription and removes from Map
     - GET /triggers - Returns active trigger configurations from Map

#### Phase 4: Cleanup

9. **Remove obsolete files**
   - Delete `src/common/states.ts` and `states.spec.ts` (StateTracker)
   - Delete `src/trigger/trigger.ts`, `trigger.service.ts`, and `trigger.spec.ts`
   - Delete entire `src/trigger/` directory after moving needed files
   - Keep View tests, just update them for new output format

10. **Update module structure**
    ```
    src/
    ├── streaming/
    │   ├── view.ts (kept as-is, refactored internally)
    │   ├── view.service.ts (kept as-is)
    │   ├── source.ts
    │   ├── source.service.ts
    │   └── streaming.module.ts
    └── api/
        ├── api.module.ts (renamed from graphql.module.ts)
        ├── schema.ts
        ├── subscriptions.ts
        ├── subscription-adapter.ts (new - maps state transitions to GraphQL)
        ├── trigger.controller.ts (moved from trigger/)
        ├── trigger.dto.ts (moved from trigger/)
        └── webhook.service.ts (new - manages triggers and fires webhooks)
    ```

#### Phase 5: Testing & Demo

11. **Update tests**
    - Update view.spec.ts for state transition output
    - Update GraphQL tests to handle state transitions
    - Create webhook.service.spec.ts

12. **Demo implementation**
    - Simple webhook receiver endpoint
    - Update UI to show trigger management
    - Integration tests for full flow

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