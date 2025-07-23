# E2E Tests

## Running E2E Tests

The e2e tests automatically start a fresh Materialize container using testcontainers:

```bash
npm run test:e2e
```

## Test Strategy

Our E2E test suite is organized into different test categories, each serving a specific purpose:

### 1. **Smoke Test** (`minimal.e2e-spec.ts`)
- **Purpose**: Quick sanity check that the application starts
- **Characteristics**: Mocked database, no external dependencies
- **Runtime**: < 1 second
- **Use case**: CI/CD pipelines, pre-commit hooks

### 2. **Integration Test** (`graphql-subscriptions.e2e-spec.ts`)
- **Purpose**: Functional testing of the complete system
- **Coverage**:
  - All CRUD operations (INSERT, UPDATE, DELETE)
  - Multiple concurrent WebSocket connections
  - Late joiners receiving proper snapshots
  - Complex operation sequences
  - All PostgreSQL data types
  - Multiple sources in parallel
  - Error handling for invalid queries
- **Runtime**: ~30 seconds
- **Use case**: Pull request validation, release testing

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

### 4. **Performance/Stress Test** (TODO)
- **Purpose**: Validate system behavior under load
- **Coverage**:
  - High throughput (1000+ updates/second)
  - Many concurrent connections (100+ WebSocket clients)
  - Large snapshots (100k+ rows)
  - Memory usage patterns
  - Latency measurements
- **Runtime**: ~10 minutes
- **Use case**: Capacity planning, performance regression testing

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

## Data Types Tested

The test schema includes two tables to ensure comprehensive type coverage:

1. **users** table:
   - Text and varchar
   - Boolean
   - Timestamps (with/without timezone)
   - JSON data

2. **all_types** table:
   - Comprehensive PostgreSQL type coverage including:
   - Boolean types
   - All numeric types (smallint, integer, bigint, decimal, numeric, real, double precision)
   - String types (char, varchar, text)
   - UUID type
   - Date/time types (date, time, timestamp, timestamptz)
   - JSON and JSONB types

## Requirements

- Docker must be running
- Port 4001 must be available for the test GraphQL server
- The Materialize image (`materialize/materialized:v0.124.0`) will be automatically pulled if not present