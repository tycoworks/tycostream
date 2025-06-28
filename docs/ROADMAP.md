# Milestone 1 — GraphQL Streaming API (MVP)

## Milestone 1.1 — Minimal Streaming

**Goal:** Stream a single view via Apollo GraphQL client with minimal config.

**Experience:**

* Set environment variables: Materialize config + single view name
* Start tycostream: docker-compose up
* Stream real-time updates over GraphQL WebSockets

**Key Features:**

* Initial snapshot + live updates from one view
* WebSocket / GraphQL endpoint
* Simple config

---

## Milestone 1.2 — Filtering + Nested Queries

**Goal:** Request filtered subsets of live data and query nested structures.

**Experience:**

* Set environment variables as before
* Start tycostream: docker-compose up
* Use Apollo Client to request filtered data (e.g. where user\_id = 123)
* Query nested data representing relationships (e.g. trades -> instrument)

**New Features:**

* GraphQL filter syntax + server-side filtering
* Nested queries based on relational structures
* Filtering by user/session/context

---

## Milestone 1.3 — Multi-View + Manual Schema

**Goal:** Subscribe to multiple views via Apollo GraphQL client using manually defined schemas.

**Experience:**

* Define GraphQL schema using SDL to map to multiple Materialize views
* Start tycostream with updated config pointing to new views and schema file
* Use Apollo Client to subscribe to any view defined in the schema
* Iterate on your schema independently of the Materialize SQL shape

**New Features:**

* Support for multiple views
* Define GraphQL schema using SDL (Schema Definition Language)
* Configure schema structure and access rules in a version-controlled file (e.g. metadata.yaml)

---

# Milestone 2 — Production-Ready

**Goal:** Deploy tycostream securely with observability, role-based access, and fault tolerance.

**New Features:**

* JWT-based authentication
* Role-based access control (RBAC) — control operations available to user roles
* Row-level entitlements — control which data rows users can access
* Observability: Prometheus metrics, structured logs, health checks
* High-availability support for real-time transport (WebSockets or SSE) using Redis or NATS
* Reconnect handling for dropped client WebSocket connections
* Fan-out support for multi-client subscriptions per view
* Backpressure
* Support for Live Query over SSE
* Support for RisingWave as an alternative backend
* Support for multi-source configuration (e.g. Materialize and RisingWave in one deployment)
* Hasura-compatible introspection and schema generation

---

# Milestone 3 — Hosted

**Goal:** Integrate and use tycostream as a service, and integrate with downstream GraphQL platforms.

**New Features:**

* Optional hosted/managed version with SLAs
* Admin UI for schema and metadata management
* Fully managed deployment with token-based access