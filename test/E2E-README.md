# E2E Tests

## Running E2E Tests

The e2e tests automatically start a fresh Materialize container using testcontainers:

```bash
npm run test:e2e
```

## Test Strategy

Our E2E test suite is organized into different test categories, each serving a specific purpose:

### 1. **Integration Test** (`integration.e2e-spec.ts`)
- **Purpose**: Functional testing of the complete system
- **Coverage**:
  - All CRUD operations (INSERT, UPDATE, DELETE)
  - Multiple concurrent WebSocket connections
  - Late joiners receiving proper snapshots
  - Complex operation sequences
  - All supported data types
  - Multiple sources in parallel
  - Error handling for invalid queries
  - GraphQL triggers with webhook callbacks
  - Trigger hysteresis (asymmetric fire/clear thresholds)
- **Runtime**: ~30 seconds
- **Use case**: Pull request validation, release testing

### 2. **Stress Test** (`stress-test.e2e-spec.ts`)
- **Purpose**: Validate system behavior under load
- **Coverage**:
  - High throughput (e.g. 10,000+ operations with mixed INSERT/UPDATE/DELETE)
  - Many concurrent connections (30 WebSocket clients by default)
  - Large snapshots (9,000+ rows)
  - Late joining clients during heavy load
  - Staggered client connections
  - Concurrent triggers with webhook events alongside subscriptions
- **Runtime**: ~8 minutes for full test
- **Configuration**: Use environment variables STRESS_TEST_ROWS, STRESS_TEST_CLIENTS, STRESS_TEST_DELAY
- **Use case**: Performance validation, load testing

### 3. **Resilience Test** (TODO)
- **Purpose**: Test failure scenarios and recovery behavior
- **Coverage**:
  - Database disconnection (verify fail-fast behavior)
  - Network interruptions
  - Invalid data handling
  - Resource exhaustion
  - Graceful shutdown
- **Runtime**: ~2 minutes
- **Use case**: Pre-release testing


## Current Failure Behavior

Per our implementation standards, the system follows a **fail-fast philosophy**:
- Database disconnections cause the affected source to error out
- Errors are propagated to all GraphQL subscribers
- No automatic reconnection attempts
- The application continues running but the source becomes unavailable
- Manual restart required to restore functionality

## Test Coverage Status

✅ **Implemented**:
- Basic subscription functionality (snapshot and live updates)
- Multiple source subscriptions
- All PostgreSQL data types
- Error handling for non-existent sources
- Boolean value parsing (fixed)

✅ **Additional Coverage**:
- UPDATE operations
- DELETE operations
- Late joiners (subscribe after data exists)
- Multiple concurrent connections
- Complex operation sequences
- Full `all_types` table testing
- GraphQL triggers (fire/clear conditions)
- Webhook delivery for trigger events
- Trigger hysteresis to prevent rapid firing/unfiring

## Data Types Tested

The test schema includes two tables to ensure comprehensive type coverage:

1. **users** table:
   - Text and varchar
   - Boolean
   - Timestamps (with/without timezone)
   - JSON data

2. **all_types** table:
   - Comprehensive type coverage including:
   - Boolean types
   - All numeric types (smallint, integer, bigint, decimal, numeric, real, double precision)
   - String types (char, varchar, text)
   - UUID type
   - Date/time types (date, time, timestamp, timestamptz)
   - JSON and JSONB types

## Test Infrastructure

The test suite uses a custom test infrastructure with:
- **TestEnvironment**: Manages test infrastructure (database container, NestJS app, SQL execution, webhook server)
- **TestClient**: Manages individual WebSocket subscriptions and trigger webhooks with state tracking
- **TestClientManager**: Manages multiple WebSocket test clients concurrently
- **TestScenario**: Generates test operations and expected states for multiple iterations

## Requirements

- Docker must be running
- Port 4001 must be available for the test GraphQL server  
- Port 4100 must be available for the stress test GraphQL server
- Port 3001 must be available for the webhook server (trigger callbacks)
- The Materialize image (`materialize/materialized:v0.124.0`) will be automatically pulled if not present