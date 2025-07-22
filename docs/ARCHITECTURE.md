# Architecture

## Overview

tycostream is a real-time GraphQL API that streams updates from database sources (views, tables, or any SELECT-able object) to subscribed clients. It provides a simple, configuration-driven approach to exposing streaming SQL data through standard GraphQL subscriptions.

## Technology Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: NestJS for modular architecture and dependency injection
- **GraphQL Server**: @nestjs/graphql with Apollo Server (WebSocket subscriptions)
- **Database Client**: node-postgres (Materialize uses Postgres wire protocol)
- **Streaming**: RxJS for reactive stream processing (native to NestJS)
- **Schema**: Dynamic GraphQL schema generation from YAML configuration
- **Configuration**: @nestjs/config with class-validator for validation, YAML for schema definitions

## Architecture Principles

### Modular Design with NestJS
- Organized into feature modules (Database, GraphQL, Config)
- Dependency injection for loose coupling and testability
- Single process but ready for microservices evolution
- Clear separation of concerns through NestJS module boundaries

### Reactive Streaming
- RxJS Observables for internal event propagation
- Async iterators for GraphQL subscription interface
- Clean separation between streaming infrastructure and GraphQL layer

### Configuration-Driven
- YAML schema files define GraphQL types and database sources
- Environment variables for runtime configuration
- Zero code changes needed for new sources

## Component Architecture

The system is organized into three logical layers:

### Database Module (`src/database/`)
Handles all interaction with Materialize:
- Connection pooling and lifecycle management
- Core subscriber logic returning RxJS Observables
- COPY protocol parsing for streaming data
- In-memory state management with primary key indexing
- Stream buffering and line parsing
- Automatic connection management and reconnection logic

### GraphQL Module (`src/graphql/`)
Serves the GraphQL API:
- `SchemaGenerator`: Dynamically generates GraphQL schema from YAML configuration
- `SubscriptionResolvers`: GraphQL subscription endpoints returning Observables
- Leverages NestJS GraphQL module for WebSocket handling
- Automatic client connection lifecycle management
- Built-in support for GraphQL filters and transformations

### Configuration & Common (`src/config/` and `src/common/`)
Shared infrastructure:
- Application-wide configuration with @nestjs/config
- Database connection settings with validation
- YAML schema loading and validation
- Structured logging helpers
- NestJS lifecycle hooks for graceful shutdown

## Data Flow

1. **Initial Connection**
   - Client connects via GraphQL WebSocket subscription
   - tycostream creates async iterator for the subscription
   - MaterializeStreamer connects to database if not already connected

2. **State Synchronization**
   - SUBSCRIBE query captures current source state via COPY protocol
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

### Why Pure RxJS Observables?
- Native to NestJS - GraphQL subscriptions work directly with Observables
- No need for async iterator conversion - simpler and more performant
- Rich operator ecosystem for filtering, transformation, and composition
- Better integration with NestJS dependency injection and lifecycle

### Why Single Process?
- Reduces operational complexity for initial versions
- Materialize handles scaling at the database layer
- Can evolve to multi-process when needed

### Why In-Memory Cache?
- Materialize sources (views/tables) are typically bounded in size
- Eliminates need for external state store
- Provides sub-millisecond query response times

## Future Evolution

The architecture supports several evolution paths without major rewrites:

- **Horizontal Scaling**: Add Redis for shared cache across processes
- **Authentication**: JWT validation in GraphQL middleware
- **Filtering**: Push-down filters to Materialize WHERE clauses
- **Multiple Sources**: Router pattern for source-specific handlers
- **Monitoring**: OpenTelemetry instrumentation points