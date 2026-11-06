# Database Reconnection

## Overview

Ensuring reliable connection between tycostream and streaming databases (Materialize/RisingWave) with automatic recovery from disconnections. This document covers the design and implementation of database reconnection features.

## Current State

**No reconnection strategy** - tycostream currently fails fast:
- On connection loss, process terminates
- No retry logic
- No state preservation
- Manual restart required

## Features to Implement

- **Automatic reconnection** with exponential backoff
- **State preservation** using AS OF timestamps
- **Zero data loss** between reconnections
- **Connection health monitoring** and metrics
- **Client notifications** for connection state changes

## Reconnection Strategy

> This section details the planned implementation. Current behavior is fail-fast.

### Detecting Disconnection

Monitor for:
- TCP connection drops
- Query timeouts
- Materialize error responses
- Heartbeat failures

### Preserving State

On disconnection:
1. Maintain in-memory cache
2. Store last `mz_timestamp`
3. Queue incoming client requests
4. Attempt reconnection

### Resuming with AS OF

```sql
SUBSCRIBE TO source AS OF <last_timestamp>
```

This allows:
- Resume from exact position
- No duplicate events
- No missed events
- Seamless to clients

### Exponential Backoff

```typescript
const retryConfig = {
  initialDelay: 100,     // ms
  maxDelay: 30000,       // 30s
  factor: 2,
  jitter: 0.1,
  maxRetries: null       // infinite
};
```

## Implementation Plan

### Phase 1: Basic Reconnection
- Detect connection loss
- Implement retry loop
- Fail after N attempts

### Phase 2: State Preservation
- Track `mz_timestamp`
- Implement AS OF resume
- Maintain cache during disconnect

### Phase 3: Client Transparency
- Buffer events during reconnect
- No visible interruption
- Connection state events

### Phase 4: Monitoring
- Prometheus metrics
- Health endpoints
- Alert on prolonged disconnects

## Technical Considerations

### Memory Management

During disconnection:
- Cache continues growing
- Set max cache size
- Drop old events if needed

### Timestamp Tracking

Required for AS OF:
- Extract from each event
- Store atomically
- Handle timestamp gaps

### Error Handling

Different strategies for:
- Network errors (retry)
- Query errors (fail)
- Resource exhaustion (backoff)

## Future Enhancements

- Multi-region failover
- Read replica support
- Connection pooling
- Circuit breaker patterns