# System Design: Milestone 1 — GraphQL Streaming API (MVP)

## Overview

This document outlines the system design for tycostream's first milestone: a real-time GraphQL API that streams updates from a Materialize view to subscribed clients. The system is implemented as a single process in Milestone 1, combining Materialize streaming and GraphQL delivery logic in one modular backend. The architecture maintains modular separation internally to support process-level decomposition in future milestones.

It covers the full scope of Milestone 1, including:

* Minimal streaming (1.1)
* Filtering and nested queries (1.2)
* Multi-view/manual schema support (1.3)

---

## System Goals for Milestone 1

* Stream updates from a single Materialize view to GraphQL clients over WebSocket.
* Deliver an initial snapshot and incremental updates.
* Manually defined schema (no introspection or generation).
* Minimal configuration surface for users.
* Provide a clean, extensible architecture that supports filtering logic and schema evolution in later sub-milestones.

---

## Key Components

To reflect the iterative delivery across Milestone 1, the components are grouped by their introduction in sub-milestones. Each section defines only architectural responsibilities and interactions.

### 1.1 Components — Minimal Streaming

This sub-milestone introduces the foundational components:

#### Internal Event Format

* Internal messages published from the Materialize streaming layer to the GraphQL subscription layer must conform to a shared structure aligned with Materialize’s `SUBSCRIBE` protocol.
* Format: `{ row: Record<string, any>, diff: number }`
* This format preserves compatibility with the source stream and keeps messaging efficient.

#### Backend Service

* Built using standard Node.js + TypeScript.
* Connects to Materialize using the Postgres wire protocol.
* Emits incoming row updates to the GraphQL layer through an internal pub/sub mechanism (e.g. a simple in-memory EventEmitter).
* May be re-evaluated in Milestone 2 to incorporate a Rust-based engine or high-performance runtime.

#### GraphQL API Server (GraphQL Yoga)

* Serves a WebSocket endpoint for GraphQL subscriptions using the `graphql-ws` protocol.
* Loads a statically defined GraphQL schema file corresponding to the configured view.
* Each GraphQL subscription field corresponds to a specific data stream/topic.
* Subscription resolvers map the field to a view and listen for updates via the internal pub/sub system.

### 1.2 Components — Filtering + Nested Queries

#### View Cache

* Introduced to support filtering and nested query operations.
* The primary key is determined by the field annotated with `ID!` in the SDL schema.
* Must be indexed by a primary key, which is specified in the SDL schema definition for each view.
* Should be implemented as an in-memory hashmap keyed by primary ID.
* Maintains an up-to-date in-memory representation of the latest view state.
* Acts as a queryable cache used by GraphQL resolvers to evaluate filter conditions.
* Must support row-level insert, update, and delete operations as Materialize streams updates.

#### Filtering Logic Layer

* Subscription resolvers must apply filter conditions to cached view data using query arguments passed into the subscription.
* Implemented within Yoga resolvers using standard JavaScript filtering functions.

### 1.3 Components — Multi-View + Manual Schema

#### Schema Registry Abstraction

* Introduced to support multiple concurrent view schemas.
* Backed by a static YAML metadata file that maps view names to SDL files..
* Maps view names to their corresponding schema definitions.
* May be backed by a static metadata file (e.g. `metadata.yaml`) in 1.3.
* Used at startup to build the combined schema or route incoming subscription requests.

#### Multi-View Routing

* In 1.1, field names are assumed to directly map to view names by convention.
* In 1.3, routing becomes explicit via metadata configuration in the schema registry.
* GraphQL Yoga must resolve subscription fields across multiple views.
* Implemented by loading and stitching multiple SDL files at startup based on metadata mapping. across multiple views.
* Each field is mapped to a corresponding view name and cache.
* Requires Yoga to support loading multiple schema files and composing them into a unified schema at startup.

---

## Data Flow

1. The backend connects to Materialize using the Postgres wire protocol.
2. It issues a `SUBSCRIBE` query against a configured view.
3. As row updates arrive, they are published to a local in-memory event bus.
4. The integrated GraphQL server receives subscription requests via WebSocket.
5. Subscription resolvers map each field to a corresponding view stream on the event bus.
6. Matching updates are delivered to subscribed clients in real time.

---

## Deployment Model (Milestone 1)
* The system is implemented as a single Node.js-based process in Milestone 1.
* Both the Materialize streaming logic and GraphQL Yoga server run inside the same service.
* The codebase is modularized to allow clean separation between streaming and GraphQL layers, supporting future extraction into multiple processes if needed (e.g. for scalability or fault isolation).