# Specifications
*User-visible functionality, requirements, and behavior expectations for tycostream*

## Milestone 1.1: Minimal Streaming
### 1. Goal
Enable a developer to stream real-time updates from a single Materialize view using a GraphQL WebSocket subscription, with minimal configuration.

### 2. Requirements
* Apollo Client should be able to subscribe to a GraphQL field (e.g. `live_pnl`) and receive live updates into a frontend grid or table.

The process must fail fast on startup if any critical requirement is missing or invalid — such as malformed schema files, misconfigured environment variables, or unreachable database hosts. This ensures predictable behavior and consistent state before serving subscriptions.

#### 2.0.1 Error Handling and Recovery
* System exits immediately on any runtime errors that prevent streaming service
* Clear error messages guide users on correcting configuration issues
* Automatic reconnection and resilience features planned for Milestone 2

#### 2.1 Configure
* The system expects a schema file at `./config/schema.sdl`
* Users must copy `./config/schema.example.sdl` to `./config/schema.sdl` and customize it
* Schema path resolution works in both Docker and local development environments
* If the schema file is missing or malformed, the single service must fail fast at startup and exit with an appropriate error

```env
SOURCE_HOST=your-mz-host
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize
```

##### Example SDL Schema (schema.sdl)

```graphql
# Type name matches your Materialize view name exactly
type live_pnl {
  instrument_id: ID!
  symbol: String!
  net_position: Float!
  latest_price: Float!
  market_value: Float!
  avg_cost_basis: Float!
  theoretical_pnl: Float!
}

type Subscription {
  # You control the GraphQL API naming
  livePnl: live_pnl!  # camelCase subscription field
}
```

* Copy `schema.example.sdl` to `schema.sdl` and customize for your view  
* No query parameters or filtering logic are supported in 1.1.

#### 2.1.1 Schema Requirements  
* Schema files must be valid GraphQL SDL format
* Must contain exactly one data type definition (excluding `type Subscription`)
* Multiple data types will be supported in future versions - system fails fast if more than one is found
* Exactly one field of type `ID!` must be present to serve as the primary key
* Primary key field name can be anything (e.g., `instrument_id: ID!`)
* Must include a `type Subscription` that references the data type

#### 2.2 Start
* The backend subscribes to the specified Materialize view
* The GraphQL server loads the schema and exposes a WebSocket endpoint
* GraphQL endpoint available at `/graphql` with WebSocket support
* GraphiQL development interface provided for testing subscriptions
* Each schema field maps to a view name (1:1) 
* Subscribed clients receive an initial snapshot followed by live updates

#### 2.2.1 Initial Snapshot Delivery
* When a client subscribes, the server immediately sends ALL current rows
* No pagination or batching - complete dataset is delivered at once
* After snapshot delivery, live updates begin flowing

#### 2.2.2 Row Ordering Preservation
* Rows are delivered to clients in the same order they arrive from Materialize
* No sorting or reordering is performed by tycostream
* Updates preserve the original stream order for consistency

#### 2.2.3 Schema Configuration
* Type name in SDL schema must match your Materialize view name exactly
* View name is automatically extracted from the first data type in the SDL schema
* Subscription field names can be customized independently for GraphQL API design

#### 2.3 Expected Behavior
* No fallback to HTTP (WebSocket-only for now).
* Static schema — no dynamic SDL loading or view-to-schema inference.
* Only one view supported in 1.1.

### 3. Acceptance Criteria
* A user can `docker-compose up` the system with just the `.env` file.
* Subscribing to the configured view field in the schema returns live updates via GraphQL subscription.
* No uncaught errors in stream handling, and system logs connection/subscription lifecycle events.

