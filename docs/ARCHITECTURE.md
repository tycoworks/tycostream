# Architecture

## Overview

tycostream is a real-time data streaming platform that bridges database sources (views, tables, or any SELECT-able object) to GraphQL subscriptions and webhook triggers. It provides a simple, configuration-driven approach to exposing streaming SQL data through a unified GraphQL API for both subscriptions and trigger management.

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
- Stream buffering and line parsing
- Automatic connection management and reconnection logic

### View Module (`src/view/`)
Core streaming logic that bridges database and API layers:
- Management of Source instances per data source
- Event enrichment with cached data (ensures full row for all events)
- Snapshot replay and live update unification
- Filtered view creation and lifecycle management
- Filter expression evaluation on event streams
- In-memory cache with primary key indexing

### API Module (`src/api/`)
Unified GraphQL API for all operations:
- Dynamic GraphQL schema generation from YAML configuration
- Subscription endpoints with filtered streaming support
- Mutation/Query endpoints for trigger management (create/delete/list)
- WebSocket handling via NestJS GraphQL module
- Automatic client connection lifecycle management
- Filter expression parsing and validation
- Field selection support for webhook payloads

### Configuration & Common (`src/config/` and `src/common/`)
Shared infrastructure:
- Application-wide configuration with @nestjs/config
- Database connection settings with validation
- YAML schema loading and validation
- Structured logging helpers
- NestJS lifecycle hooks for graceful shutdown

## Data Flow

1. **Initial Connection**
   - Client connects via GraphQL WebSocket subscription or creates trigger via GraphQL mutation
   - ViewService creates a View instance for the source + filter combination
   - Source connects to database if not already connected

2. **State Synchronization**
   - SUBSCRIBE query captures current source state via COPY protocol
   - Initial rows populate Source's in-memory cache
   - View filters cached state based on filter expression
   - GraphQL clients receive filtered snapshot as individual events
   - Triggers can skip snapshot for "from now on" semantics

3. **Live Updates**
   - Materialize sends incremental updates (may have partial data)
   - Source enriches events with cached data (ensures full row)
   - Updates applied to cache and propagated through unified stream
   - View transforms events: filtering rows in/out based on expression
   - GraphQL: Filtered events delivered to subscribed clients
   - Triggers: INSERT events fire webhooks (match), DELETE events clear (unmatch)

4. **Late Joiner Handling**
   - New subscribers receive filtered cached state immediately
   - Timestamp-based deduplication prevents duplicate events
   - Seamless transition from historical to live data
   - Multiple views can share same underlying stream

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
- Enables event enrichment (full row data for DELETE events)

## Future Evolution

The architecture supports several evolution paths without major rewrites:

- **Horizontal Scaling**: Add Redis for shared cache across processes
- **Authentication**: JWT validation in GraphQL middleware
- **Advanced Filtering**: Push complex filters to Materialize WHERE clauses for efficiency
- **Multiple Sources**: Router pattern for source-specific handlers
- **Monitoring**: OpenTelemetry instrumentation points
- **Webhook Delivery**: Retry logic, dead letter queues, and delivery guarantees
- **Trigger Persistence**: Optional database backing for trigger definitions