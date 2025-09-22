# Production Triggers

## Overview

Making triggers and webhooks production-ready with reliability, manageability, and failure handling. This document covers the design and implementation of production trigger features for tycostream.

## Features to Implement

### Reliability
- **At-least-once delivery** with exponential backoff
- **Dead letter queue** for failed webhooks  
- **Idempotency support** via deterministic event IDs
- **Snapshot inclusion option** - Choose whether triggers process historical data or start from creation time
- **Error webhooks** for stream disconnection events
- **Webhook retry policies** with configurable backoff and jitter

### Persistence
- **Trigger persistence** - Triggers survive restarts
- **State preservation** - Maintain trigger state across failures
- **Checkpoint management** - Resume from last processed position

### Security
- **Webhook signatures (HMAC)** for request authentication
- **TLS enforcement** for webhook endpoints
- **Secret management** for webhook credentials

### Manageability
- **Enable/disable triggers** without deletion
- **List trigger state** (enabled/disabled, last fired, match count)
- **Trigger metadata** (created_at, updated_at, created_by)
- **Query matched rows** for debugging
- **Trigger history** and audit trail
- **Debug mode** for testing without delivery

### Advanced Features
- **Cooldown periods** and rate limiting
- **Parameterized conditions** with runtime variables
- **Custom result fields** (computed values in payload)
- **Time-to-live (TTL)** and expiration
- **Field selection** for webhook payloads
- **Batch delivery** for high-volume triggers
- **Conditional delivery** based on external state

## Deterministic Event IDs and Timestamp Propagation

> **Note**: The implementation details for timestamp propagation and deterministic event IDs have been moved to [timestamp_propagation.md](timestamp_propagation.md). This section provides a summary relevant to triggers.

### Overview

Triggers require deterministic event IDs for idempotent webhook processing. These IDs are generated from:
- Trigger name
- Row primary key
- Source database timestamp (`mz_timestamp`)

This enables:
- **Idempotent processing**: Webhook consumers can deduplicate events
- **Reliable replay**: Replaying from checkpoints generates identical IDs
- **Event tracing**: Full correlation from database change to webhook delivery

### Webhook Payload

Triggers include both timestamps in webhook payloads:

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

### Consumer Implementation

Webhook consumers should implement deduplication using the deterministic event_id. See [timestamp_propagation.md](timestamp_propagation.md) for implementation examples and best practices.