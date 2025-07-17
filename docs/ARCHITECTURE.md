# Architecture

## Overview

tycostream is a real-time GraphQL API that streams updates from Materialize views to subscribed clients. It provides a simple, configuration-driven approach to exposing streaming SQL data through standard GraphQL subscriptions.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **GraphQL Server**: GraphQL Yoga (WebSocket subscriptions)
- **Database Client**: node-postgres (Materialize uses Postgres wire protocol)
- **Streaming**: RxJS for reactive stream processing
- **Async Iteration**: rxjs-for-await for Observable to AsyncIterator conversion
- **Schema**: @graphql-tools/schema for dynamic schema generation
- **Configuration**: Zod for validation, YAML for schema definitions

## Architecture Principles

### Single Process Design
- All components run in a single Node.js process
- Simplifies deployment and reduces operational complexity
- Suitable for most real-time streaming use cases

### Reactive Streaming
- RxJS Observables for internal event propagation
- Async iterators for GraphQL subscription interface
- Clean separation between streaming infrastructure and GraphQL layer

### Configuration-Driven
- YAML schema files define GraphQL types and Materialize views
- Environment variables for runtime configuration
- Zero code changes needed for new views

## Component Architecture

The system is organized into three logical layers:

### Database Layer (`src/database/`)
Handles all interaction with Materialize:
- Manages SUBSCRIBE connections using Postgres wire protocol
- Implements COPY protocol parsing for streaming data
- Maintains in-memory cache of current view state
- Provides async iterators for consuming updates
- Handles connection lifecycle and reconnection logic

### GraphQL Layer (`src/graphql/`)
Serves the GraphQL API:
- Orchestrates HTTP and WebSocket servers
- Dynamically generates GraphQL schema from YAML configuration
- Implements subscription resolvers that consume database streams
- Manages client connection lifecycle
- Handles graceful shutdown of active subscriptions

### Core Utilities (`src/core/`)
Shared infrastructure:
- Configuration loading and validation with environment variables
- Structured logging with component isolation
- YAML to GraphQL schema transformation
- Graceful shutdown coordination across components

## Data Flow

1. **Initial Connection**
   - Client connects via GraphQL WebSocket subscription
   - tycostream creates async iterator for the subscription
   - MaterializeStreamer connects to database if not already connected

2. **State Synchronization**
   - SUBSCRIBE query captures current view state via COPY protocol
   - Initial rows populate in-memory cache
   - Client receives complete current state as individual events

3. **Live Updates**
   - Materialize sends incremental updates (inserts/updates/deletes)
   - Updates applied to cache and propagated to subscribers
   - RxJS ReplaySubject ensures no updates lost during subscription handoff

4. **Late Joiner Handling**
   - New subscribers receive cached state immediately
   - Timestamp-based filtering prevents duplicate events
   - Seamless transition from historical to live data

## Key Design Decisions

### Why RxJS?
- Natural fit for streaming data with operators for filtering and transformation
- ReplaySubject pattern elegantly solves late-joiner race conditions
- Well-tested library with excellent TypeScript support

### Why Async Iterators?
- GraphQL subscriptions expect AsyncIterator interface
- Clean abstraction over underlying RxJS implementation
- Allows future migration to different streaming primitives

### Why Single Process?
- Reduces operational complexity for initial versions
- Materialize handles scaling at the database layer
- Can evolve to multi-process when needed

### Why In-Memory Cache?
- Materialize views are typically bounded in size
- Eliminates need for external state store
- Provides sub-millisecond query response times

## Future Evolution

The architecture supports several evolution paths without major rewrites:

- **Horizontal Scaling**: Add Redis for shared cache across processes
- **Authentication**: JWT validation in GraphQL middleware
- **Filtering**: Push-down filters to Materialize WHERE clauses
- **Multiple Views**: Router pattern for view-specific handlers
- **Monitoring**: OpenTelemetry instrumentation points