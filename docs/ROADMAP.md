# Milestone 1 — GraphQL Streaming API (MVP)

## Milestone 1.1 — Minimal Streaming
**Goal:** Stream a single view to one GraphQL client with minimal config.

**Experience:**

* Set environment variables: Materialize config + single view name
* Start tycostream: docker-compose up
* Connect single client to stream real-time updates over GraphQL WebSockets

**Key Features:**

* Single-process implementation: both GraphQL and streaming logic run in one backend service.
* Initial snapshot + live updates from one view
* WebSocket / GraphQL endpoint
* Simple config

---

## Milestone 1.2 — Filtering + YAML config
**Goal:** Multiple clients can request filtered subsets of live data.

**Experience:**

* Set environment variables as before
* Start tycostream: docker-compose up
* Connect multiple clients simultaneously
* Each client can request filtered data (e.g. where user\_id = 123)
* Query nested data representing relationships (e.g. trades -> instrument)

**New Features:**

* Generate GraphQL schema from YAML config
* Hasura-style filters

---

## Milestone 1.3 — Multi-View + Nested Queries
**Goal:** Subscribe to multiple views with nested structures.

**Experience:**

* Define GraphQL schema to map to multiple Materialize views
* Start tycostream with updated config pointing to new views and schema files
* Use Apollo Client to subscribe to any view defined in the schema
* Iterate on your schema independently of the Materialize SQL shape

**New Features:**

* Support for multiple views
* Nested queries based on relational structures

---

# Milestone 2 — Production-Ready
**Goal:** Deploy tycostream securely with observability, role-based access, and fault tolerance.

**New Features:**

* JWT-based authentication
* Role-based access control (RBAC) — control operations available to user roles
* Row-level entitlements — control which data rows users can access
* Observability: Prometheus metrics, structured logs, health checks
* Robust Materialize Connection Handling:
  - Automatic reconnection with exponential backoff
  - Circuit breaker patterns for failed connections
  - Stream health monitoring and validation
  - Production error recovery procedures
  - Runtime view existence validation
* Resilient GraphQL Server Operations:
  - Graceful error recovery for server failures
  - Client connection management and cleanup
  - WebSocket connection resilience
* Separation of Materialize and GraphQL services for independent scaling and deployment.
* High-availability support for real-time transport (WebSockets or SSE) using Redis or NATS
* Reconnect handling for dropped client WebSocket connections
* Fan-out support for multi-client subscriptions per view
* Pagination
* Update coalescing for high-frequency data:
  - Client-configurable coalescing (opt-in)
  - Combine multiple updates for same entity within time window
  - Reduce network overhead for market data scenarios
* Backpressure and cache management:
  - Cache size limits and LRU eviction
  - Memory pressure monitoring
  - Graceful degradation during outages
* Support for Live Query over SSE
* Support for RisingWave as an alternative backend
* Support for multi-source configuration (e.g. Materialize and RisingWave in one deployment)
* Hasura-compatible introspection and schema generation
* Comprehensive integration test suite using Materialize emulator with real streaming scenarios

---

# Milestone 3 — Hosted
**Goal:** Integrate and use tycostream as a service, and integrate with downstream GraphQL platforms.

**New Features:**

* Optional hosted/managed version with SLAs
* Admin UI for schema and metadata management
* Fully managed deployment with token-based access