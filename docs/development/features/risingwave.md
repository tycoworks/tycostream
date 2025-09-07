# RisingWave Support Implementation Guide

## Executive Summary

This document outlines the strategy for adding RisingWave support to tycostream alongside the existing Materialize implementation. While RisingWave uses a different streaming mechanism - **subscription cursors with blocking fetch** rather than Materialize's **SUBSCRIBE with COPY protocol** - both can be cleanly mapped to the same internal architecture using async iteration patterns.

## Key Differences: RisingWave vs Materialize

### Streaming Model
- **Materialize**: Push-based SUBSCRIBE with COPY protocol
  - `COPY (SUBSCRIBE ...) TO STDOUT` pushes data continuously
  - Data flows automatically through pg-copy-streams
  - Natural async stream in Node.js
  
- **RisingWave**: Subscription cursors with blocking fetch
  - Create subscription, then declare cursor
  - Use blocking FETCH (no timeout) that waits for data
  - Behaves like async iteration - blocks until data arrives
  - No polling, no timers - database handles the wait

### Protocol Implementation
- **Materialize**: Uses PostgreSQL COPY text protocol
  - Tab-delimited format with `\N` for nulls
  - Streams through pg-copy-streams Node.js library
  - Single continuous stream connection

- **RisingWave**: Uses standard PostgreSQL query protocol
  - Returns regular result sets from FETCH operations
  - Each FETCH blocks until new data arrives
  - Clean async iteration pattern

## Implementation Strategy

### Current Architecture Problem

The existing `DatabaseStream` class is tightly coupled to pg-copy-streams and Materialize's COPY protocol. It assumes all protocol handlers will use `COPY (SUBSCRIBE ...) TO STDOUT`. This needs refactoring to support RisingWave's different approach.

### Proposed Architecture Refactoring

Looking at the current separation of concerns:

**Current State (Good separation):**
- `DatabaseStream` - Transport layer (connection, pg-copy-streams, buffering)
- `MaterializeProtocolHandler` - Database-specific logic (SUBSCRIBE query, column ordering, parsing)

**The Problem:**
`DatabaseStream` assumes COPY protocol (`COPY (${subscribeQuery}) TO STDOUT`). This won't work for RisingWave.

**Recommended Solution: Interface-based approach**

Keep the clean separation but make it pluggable:

```
StreamTransport (interface)
├── CopyStreamTransport (current DatabaseStream, renamed)
│   └── Uses pg-copy-streams for COPY protocol
└── CursorStreamTransport (new for RisingWave)
    └── Uses blocking FETCH with async iteration

ProtocolHandler (current interface)
├── MaterializeProtocolHandler (unchanged)
│   └── SUBSCRIBE query + column ordering + parsing
└── RisingWaveProtocolHandler (new)
    └── Subscription/cursor setup + result parsing
```

The factory would pair:
- Materialize → CopyStreamTransport + MaterializeProtocolHandler
- RisingWave → CursorStreamTransport + RisingWaveProtocolHandler

This maintains the clean separation you want - transport doesn't know about column ordering, and protocol handlers don't deal with connection management.

### Phase 1: Database Type Configuration

Add database type to configuration to route to appropriate implementation. Environment variable: `DATABASE_TYPE` (required, no default - fail fast if not specified). Valid values: `materialize` | `risingwave`

### Phase 2: Stream Factory Pattern

The `DatabaseStreamService` becomes a factory that creates the appropriate stream type based on database configuration. This keeps the `Source` class unchanged - it just receives callbacks from whichever stream implementation is used.

### Phase 3: RisingWave Implementation

The RisingWave stream would:
1. Create subscription and cursor on connect
2. Run async iteration loop with blocking FETCH (no timers!)
3. Parse result sets and invoke callbacks
4. Clean up subscription/cursor on disconnect

The key is using blocking FETCH that naturally waits for data - this behaves like an async iterable and maps cleanly to the callback pattern.

## Key Implementation Challenges

### 1. Async Iteration Pattern
- **Challenge**: RisingWave uses blocking FETCH instead of push-based streaming
- **Solution**: Use async generators to wrap blocking FETCH in clean async iteration
- **Benefit**: No polling, no timers - database handles blocking naturally

### 2. Operation Type Mapping
- **Challenge**: RisingWave uses different operation types (Insert, UpdateInsert, UpdateDelete, Delete)
- **Solution**: Map RisingWave operations to our DatabaseRowUpdateType enum
  - Insert → Upsert
  - UpdateInsert → Upsert  
  - UpdateDelete → Delete (for the old row)
  - Delete → Delete

### 3. Connection Management
- **Challenge**: Need to manage subscription and cursor lifecycle
- **Solution**: 
  - Create unique names with timestamps to avoid conflicts
  - Clean up subscriptions and cursors on disconnect
  - Handle connection failures and retry logic

### 4. Performance Considerations
- **Challenge**: Each FETCH is a separate database round-trip
- **Solution**:
  - Blocking FETCH eliminates unnecessary round-trips
  - Natural backpressure - only fetch when ready to process
  - Connection pooling for multiple subscriptions

### 5. Transaction Boundaries
- **Challenge**: RisingWave doesn't support COPY protocol streaming
- **Solution**: Each FETCH is a separate transaction, need to handle accordingly

## Testing Strategy

### Unit Tests
- Test RisingWaveProtocolHandler parsing logic
- Test operation type mapping
- Mock cursor fetch responses

### Integration Tests
- Set up test RisingWave instance
- Verify subscription creation and cursor operations
- Test data flow from RisingWave to GraphQL subscriptions
- Compare behavior between Materialize and RisingWave

### Performance Tests
- Measure latency difference between push and pull models
- Test with high-volume data streams
- Monitor resource usage (CPU, memory, connections)

## Migration Path

1. **Environment Variable**: Users can switch between databases using `DATABASE_TYPE`
2. **Gradual Rollout**: Test with non-critical sources first
3. **Dual Support**: Maintain both implementations side-by-side
4. **Documentation**: Provide clear migration guide for users

## Configuration Example

```yaml
# .env for RisingWave
DATABASE_TYPE=risingwave  # Required - no default
DATABASE_HOST=localhost
DATABASE_PORT=4566  # RisingWave default port
DATABASE_USER=root
DATABASE_PASSWORD=
DATABASE_NAME=dev

# .env for Materialize
DATABASE_TYPE=materialize  # Required - no default
DATABASE_HOST=localhost
DATABASE_PORT=6875  # Materialize default port
DATABASE_USER=materialize
DATABASE_PASSWORD=materialize
DATABASE_NAME=materialize

# schema.yaml remains the same for both
sources:
  trades:
    primary_key: trade_id
    columns:
      trade_id: int8
      symbol: text
      price: numeric
      quantity: int4
```

## Monitoring and Observability

### Metrics to Track
- Fetch latency (round-trip time for blocking fetch)
- Rows per fetch
- Time blocked waiting for data
- Connection failures and retries
- Subscription/cursor creation failures

### Logging
- Log subscription and cursor creation
- Log fetch operations with row counts
- Log operation type distribution
- Log connection lifecycle events

## Architecture Notes

### Data Flow Consistency

Both Materialize and RisingWave follow the same internal data flow:

1. **Database Stream** → Receives events (push or pull)
2. **Convert to Callbacks** → Unified callback interface
3. **Source Class** → Converts callbacks to RxJS Observable
4. **ViewService** → Applies filtering and transformations
5. **GraphQL Layer** → Converts Observable to AsyncIterable via `eachValueFrom`

This architecture means:
- RxJS remains the internal event bus for both databases
- Powerful operators (filter, buffer, etc.) work identically
- GraphQL subscriptions behave the same regardless of database
- The only difference is how events enter the system (COPY vs blocking FETCH)

### Why Not AsyncIterable Throughout?

While we could use AsyncIterable as the internal abstraction, RxJS provides:
- Rich operator ecosystem (filter, debounce, buffer, etc.)
- Multicast support (multiple subscribers to same stream)
- Backpressure handling
- Error recovery patterns
- Existing integration with NestJS

The conversion to AsyncIterable happens only at the GraphQL boundary where it's required by the GraphQL subscription spec.

## Next Steps

1. **Prototype**: Build minimal RisingWaveStream implementation
2. **Test Connection**: Verify basic subscription/cursor operations work
3. **Performance Testing**: Compare latency and throughput with Materialize
4. **Error Handling**: Implement robust retry and recovery logic
5. **Documentation**: Create user guide for RisingWave configuration

## Required Code Changes Summary

### Refactoring Approach

Extract interfaces and rename for clarity:

1. **Create `StreamTransport` interface** with methods:
   - `connect(onUpdate, onError)`
   - `disconnect()`
   - `get streaming()`

2. **Rename/refactor existing classes**:
   - `DatabaseStream` → `CopyStreamTransport` (implements `StreamTransport`)
   - Keep `MaterializeProtocolHandler` as-is

3. **Add RisingWave implementation**:
   - `CursorStreamTransport` (implements `StreamTransport`)
   - `RisingWaveProtocolHandler` (implements modified `ProtocolHandler`)

### New Files to Create
1. `src/database/stream-transport.interface.ts` - Common transport interface
2. `src/database/copy-stream-transport.ts` - Renamed DatabaseStream
3. `src/database/cursor-stream-transport.ts` - RisingWave transport
4. `src/database/risingwave.ts` - RisingWave protocol handler

### Files to Modify
1. `src/config/database.config.ts` - Add DatabaseType enum
2. `src/database/stream.service.ts` - Factory to create transport+handler pairs
3. `src/database/stream.ts` - Rename to copy-stream-transport.ts
4. `src/database/types.ts` - Potentially adjust ProtocolHandler interface

### Interface Adjustments

The `ProtocolHandler` interface needs tweaking:
- `createSubscribeQuery()` only makes sense for COPY protocol
- Could make it optional or move to Materialize-specific interface
- RisingWave handler would handle subscription/cursor setup differently

## Risks and Mitigations

### Performance Risks
- **Risk**: Polling overhead could impact performance
- **Mitigation**: Use blocking cursors with optimized timeout values

### Compatibility Risks  
- **Risk**: RisingWave may not support all PostgreSQL types we use
- **Mitigation**: Test type compatibility early, provide type mapping layer

### Operational Risks
- **Risk**: Subscription/cursor cleanup on crashes
- **Mitigation**: Implement subscription naming convention with cleanup on startup

## Conclusion

Supporting RisingWave is architecturally straightforward once we address the current coupling between `DatabaseStream` and pg-copy-streams. The blocking cursor pattern is effectively an async iterable - no polling, no timers, just natural async iteration that blocks until data arrives.

The main work is refactoring the existing code to separate Materialize-specific logic (COPY protocol, pg-copy-streams) from the generic streaming interface. Once that's done, RisingWave support slots in cleanly:

1. **Both databases provide real-time streams** - different protocols, same callbacks
2. **Both feed into RxJS Observables** - maintaining all existing functionality  
3. **GraphQL subscriptions work identically** - transparent to clients

The key insight is that **RisingWave's blocking FETCH is production-viable** for backend services like tycostream that handle fan-out at the application layer. The direct cursor approach is simpler than adding a message broker and perfectly adequate for many real-world use cases.

No magic numbers, no arbitrary batch sizes, no polling timers - just clean async iteration with natural backpressure.