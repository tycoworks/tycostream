# Specifications
*User-visible functionality, requirements, and behavior expectations for tycostream*

## Milestone 1.1: Minimal Streaming
### 1. Goal
Enable a developer to stream real-time updates from a single Materialize view using a GraphQL WebSocket subscription, with minimal configuration.

### 2. Requirements
* Apollo Client should be able to subscribe to a GraphQL field (e.g. `live_pnl`) and receive live updates into a frontend grid or table.

The process must fail fast on startup if any critical requirement is missing or invalid — such as malformed YAML schema files, misconfigured environment variables, ports already in use, or unreachable database hosts. This ensures predictable behavior and consistent state before serving subscriptions.

#### 2.0.1 Error Handling and Recovery
* System exits immediately on any runtime errors that prevent streaming service
* Clear error messages guide users on correcting configuration issues
* Automatic reconnection and resilience features planned for Milestone 2

#### 2.1 Configure
* The system expects a schema file at `./config/schema.yaml`
* Users must copy `./config/schema.example.yaml` to `./config/schema.yaml` and customize it
* Schema path resolution works in both Docker and local development environments
* If the schema file is missing or malformed, the single service must fail fast at startup and exit with an appropriate error
* Log verbosity controlled via `LOG_LEVEL` environment variable (values: `debug`, `info`, `warn`, `error`)

```env
SOURCE_HOST=localhost
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize

GRAPHQL_PORT=4000
GRAPHQL_UI=true

LOG_LEVEL=info
```

##### Example YAML Schema (schema.yaml)

```yaml
views:
  live_pnl:
    view: live_pnl
    primary_key: instrument_id
    columns:
      instrument_id: integer
      symbol: text
      net_position: bigint
      latest_price: double precision
      market_value: double precision
      avg_cost_basis: numeric
      theoretical_pnl: double precision
```

* Copy `schema.example.yaml` to `schema.yaml` and customize for your view  
* No query parameters or filtering logic are supported in 1.1.

#### 2.1.1 Schema Requirements  
* Schema files must be valid YAML format
* Must contain exactly one view definition per schema file
* Multiple views will be supported in future versions - system fails fast if more than one is found
* Primary key specified using `primary_key` attribute and must reference a column name
* GraphQL schema is automatically generated from the view definition, including:
  - Type definition using the view name (e.g., `live_pnl`)
  - Query field for current state (e.g., `live_pnl: [live_pnl!]!`)
  - Subscription field for real-time updates (e.g., `live_pnl: live_pnl!`)
  - All field names and types from the `columns` section

#### 2.1.2 Schema Compatibility Requirements
* YAML schema uses PostgreSQL wire protocol type names (e.g., `integer`, `text`, `double precision`) that must match the corresponding Materialize view column types
* Field names and order in YAML must match the Materialize view structure exactly
* Schema mismatches will be handled and reported at runtime

#### 2.2 Start
* The backend subscribes to the specified Materialize view
* The GraphQL server loads the schema and exposes a WebSocket endpoint
* GraphQL endpoint available at `/graphql` with WebSocket support
* Optional GraphQL UI available for development testing when `GRAPHQL_UI=true`
* Each schema field maps to a view name (1:1) 
* Subscribed clients receive the current view state followed by live updates

#### 2.2.1 Initial State Delivery
* When a client subscribes, the server immediately sends ALL current rows
* No pagination or batching - complete dataset is delivered at once
* After current state delivery, live updates begin flowing

#### 2.2.2 Row Ordering Preservation
* Rows are delivered to clients in the same order they arrive from Materialize
* No sorting or reordering is performed by tycostream
* Updates preserve the original stream order for consistency

#### 2.2.3 Schema Generation
* GraphQL schema is dynamically generated from YAML configuration at startup
* Generated schema includes a type, query field, and subscription field using the YAML key as GraphQL type name
* Field names and types are mapped directly from the `columns` section
* The `view` field maps to the actual Materialize view name for database queries
* This separation allows GraphQL type names to differ from database view names

#### 2.3 Expected Behavior
* No fallback to HTTP (WebSocket-only for now).
* Static schema — no dynamic YAML loading or view-to-schema inference.
* Only one view supported in 1.1.
* Multiple concurrent clients can subscribe independently.
* Each client receives their own isolated event stream.
* Client disconnections do not affect other active subscriptions.
* Clients can connect before any data arrives from Materialize (updates stream as they come).
* New clients never receive stale updates - only current state followed by live updates.

### 3. Acceptance Criteria
* A user can `docker-compose up` the system with just the `.env` file.
* Subscribing to the configured view field in the schema returns live updates via GraphQL subscription.
* Multiple clients can connect simultaneously and receive independent update streams.
* Each new client receives the full current state before live updates begin.
* Client disconnections are handled gracefully without affecting other clients.
* No uncaught errors in stream handling, and system logs connection/subscription lifecycle events.