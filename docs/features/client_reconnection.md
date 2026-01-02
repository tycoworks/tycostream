# Client Reconnection

## Overview

Managing WebSocket client reconnections and handling slow consumers to ensure reliable client connections and prevent memory issues. This document covers the design and implementation of client-side connection reliability.

## Current State

**Basic WebSocket with no resilience**:
- Snapshot-on-connect (full state as INSERT events)
- No reconnection support (new connection = new snapshot)
- Unbounded buffers (slow clients can cause memory growth)
- No backpressure mechanism
- No client health monitoring

## Features to Implement (MVP)

- **Bounded buffers** to prevent memory exhaustion
- **Basic drop policy** (drop oldest when full)
- **Simple WebSocket reconnection** support
- **Connection lifecycle** management
- **Basic health monitoring** (disconnect detection)

## Enterprise Features (Future)

- **Advanced backpressure** (adaptive buffers, per-client QoS)
- **Configurable drop policies** (by age, priority, sampling)
- **Session management** with replay capabilities (?)
- **Connection quality metrics** and dashboards
- **Client-specific throttling** and rate limiting

## Slow Consumer Management

> This section details the planned implementation for handling slow clients.

### Detection

Monitor per-client:
- Buffer size growth
- Event processing rate
- Lag between send and acknowledge

### Mitigation

```typescript
const bufferConfig = {
  maxSize: 10000,           // events
  dropPolicy: 'drop-oldest',
  warnThreshold: 0.8,       // 80% full
  disconnectThreshold: 0.95  // 95% full
};
```

### Actions

1. Warning event to client at 80%
2. Start dropping old events at 100%
3. Disconnect if sustained backpressure

## Implementation Plan

### MVP Implementation

**Phase 1: Basic Protection**
- Implement bounded buffers (fixed size)
- Simple drop-oldest policy
- Prevent OOM crashes

**Phase 2: Basic Reconnection**
- WebSocket reconnection support
- Connection state tracking
- Clean disconnection handling

### Enterprise Implementation

**Phase 3: Advanced Buffering**
- Configurable buffer sizes
- Multiple drop strategies
- Per-client configurations

**Phase 4: Enhanced Features**
- Session-based replay
- Connection quality metrics
- Adaptive backpressure
- Client dashboards

## Technical Considerations

### Buffer Management

Replace unbounded replay subjects with:
- Ring buffers per client
- Configurable size limits
- Clear eviction policies

### Client Identification

For session support:
- Optional client IDs
- Session token generation
- TTL for abandoned sessions

### Event Ordering

During buffer pressure:
- Maintain order guarantees
- Clear drop notifications
- Recovery strategies

## Future Enhancements

- Adaptive buffer sizing
- Client-specific QoS levels
- Compression for slow links
- WebSocket multiplexing