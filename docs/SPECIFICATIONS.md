# Specifications

## Milestone 1.1: Minimal Streaming

### 1. Goal

Enable a developer to stream real-time updates from a single Materialize view using a GraphQL WebSocket subscription, with minimal configuration.

### 2. Requirements

* Apollo Client should be able to subscribe to a GraphQL field (e.g. `live_pnl`) and receive live updates into a frontend grid or table.

Unless otherwise stated, tycostream services are expected to follow an all-or-nothing startup policy: if one process fails (e.g. due to missing config, schema mismatch, or invalid view), the other must also fail fast. This ensures predictable behavior and consistent state during system initialization.

#### 2.1 Configure

* The system expects a schema file at `./schema/{VIEW_NAME}.sdl`.
* If the schema file is missing or malformed, the single service must fail fast at startup and exit with an appropriate error.

```env
SOURCE_HOST=your-mz-host
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize
VIEW_NAME=live_pnl
```

##### Example SDL Schema (live\_pnl.sdl)

```graphql
type LivePNL {
  instrument_id: ID!
  symbol: String!
  net_position: Float!
  latest_price: Float!
  market_value: Float!
  avg_cost_basis: Float!
  theoretical_pnl: Float!
}

type Subscription {
  live_pnl: LivePNL!
}
```

* Schema is statically defined and must exist at `./schema/{VIEW_NAME}.sdl` unless overridden.
* No query parameters or filtering logic are supported in 1.1.

#### 2.2 Start

* The backend subscribes to the specified Materialize view.
* Incoming rows are published to an internal event bus.
* The embedded GraphQL server loads the schema and exposes a WebSocket endpoint (`graphql-ws`).
* Each schema field maps to a view name (1:1).
* Subscribed clients receive an initial snapshot followed by live updates.

#### 2.3 Expected Behavior

* No fallback to HTTP (WebSocket-only for now).
* Static schema — no dynamic SDL loading or view-to-schema inference.
* Only one view supported in 1.1.

### 3. Acceptance Criteria

* A user can `docker-compose up` the system with just the `.env` file.
* Subscribing to the `live_pnl` field in the schema returns live updates via GraphQL subscription.
* No uncaught errors in stream handling, and system logs connection/subscription lifecycle events.

### 4. Open Questions / TODOs

* If the schema file is missing, both Encore and Yoga must fail fast and exit with a clear error message.
