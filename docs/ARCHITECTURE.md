# System Design: Milestone 1 — GraphQL Streaming API (MVP)
*High-level system design, technology choices, and component architecture*

## Overview

This document outlines the system design for tycostream's first milestone: a real-time GraphQL API that streams updates from a Materialize view to subscribed clients. The system is implemented as a single process in Milestone 1, combining Materialize streaming and GraphQL delivery logic in one modular backend. The architecture maintains modular separation internally to support process-level decomposition in future milestones.

It covers the full scope of Milestone 1, including:

* Minimal streaming (1.1)
* Filtering and nested queries (1.2)
* Multi-view/manual schema support (1.3)

---

## System Goals for Milestone 1

* Stream updates from a single Materialize view to GraphQL clients over WebSocket
* Deliver an initial snapshot and incremental updates
* Manually defined schema (no introspection or generation)
* Minimal configuration surface for users
* Provide a clean, extensible architecture that supports filtering logic and schema evolution in later sub-milestones

---

## Key Components

To reflect the iterative delivery across Milestone 1, the components are grouped by their introduction in sub-milestones. Each section defines only architectural responsibilities and interactions.

### 1.1 Components — Minimal Streaming

This sub-milestone introduces the foundational components:

#### Backend Service

* Built using standard Node.js + TypeScript
* Connects to Materialize using the Postgres wire protocol
* Emits incoming row updates to the GraphQL layer through an internal pub/sub mechanism
* May be re-evaluated in Milestone 2 to incorporate a Rust-based engine or high-performance runtime

#### GraphQL API Server (GraphQL Yoga)

* Serves a WebSocket endpoint for GraphQL subscriptions using the `graphql-ws` protocol
* Loads a statically defined GraphQL schema file
* Each GraphQL subscription field corresponds to a specific data stream/topic
* Subscription resolvers provide initial snapshots and live updates

### 1.2 Components — Filtering + Nested Queries

#### View Cache

* **Required in 1.1** for initial snapshot delivery (originally planned for 1.2)
* Maintains an up-to-date in-memory representation of the latest view state
* Supports row-level operations based on streaming diff values
* Acts as a queryable cache used by GraphQL resolvers to evaluate filter conditions
* Provides immediate snapshot data for new subscription clients

#### Filtering Logic Layer

* Subscription resolvers apply filter conditions to cached view data using GraphQL query arguments
* Filtering operates on the in-memory view cache for real-time query evaluation

### 1.3 Components — Multi-View + Manual Schema

#### Schema Registry Abstraction

* Introduced to support multiple concurrent view schemas
* Backed by a static YAML metadata file that maps view names to SDL schema definitions
* Maps view names to their corresponding schema definitions
* Used at startup to build the combined schema or route incoming subscription requests

#### Multi-View Routing

* In 1.3, routing becomes explicit via metadata configuration in the schema registry
* GraphQL Yoga must resolve subscription fields across multiple views
* Each field is mapped to a corresponding view name and cache
* Requires Yoga to support loading multiple schema files and composing them into a unified schema at startup

---

## Data Flow

1. **Startup**: Backend validates configuration and loads GraphQL schema
2. **Connection**: Backend connects to Materialize using Postgres wire protocol
3. **Streaming**: Issues `SUBSCRIBE` query against configured view
4. **Event Processing**: As row updates arrive, they are:
   - Applied to ViewCache for state maintenance
   - Published to internal pub/sub system
5. **Client Subscription**: GraphQL server receives subscription requests via WebSocket
6. **Initial Snapshot**: Subscription resolver immediately yields all current rows from ViewCache
7. **Live Updates**: Resolver subscribes to pub/sub events and yields new updates in real time

---

## Deployment Model (Milestone 1)
* The system is implemented as a single Node.js-based process in Milestone 1
* Both the Materialize streaming logic and GraphQL Yoga server run inside the same service
* The codebase is modularized to allow clean separation between streaming and GraphQL layers, supporting future extraction into multiple processes if needed (e.g. for scalability or fault isolation)