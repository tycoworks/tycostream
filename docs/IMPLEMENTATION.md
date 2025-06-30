# Implementation details and approach
*Development practices, coding standards, testing strategies, and technical implementation details*
## 1. Philosophy

> This project is a foundation-layer service. Our goal is correctness, modularity, testability, and maintainability — not premature optimization.
> 

Key points:

- **Bias for simplicity and clarity**: readable over clever.
- **Structure around interfaces**, not implementation details.
- **Build for replaceability**: no hidden state, hard-coded logic, or tight coupling.

---

## 2. Project Structure

Outline how code should be organized:

- `/src/` – Node.js + TypeScript service that handles both streaming and GraphQL delivery logic
- `/config/` – SDL schemas and metadata config
- `/shared/` – event definitions, config, logging, types
- `/tests/` – isolated unit tests per module, integration tests

---

## 3. Modularity Guidelines

- Each component must expose a **clear interface**.
- No circular dependencies — isolate read/update responsibilities.
- Pub/sub, cache, filters, schema loaders — all should be **plug-and-play**.
- Design so that **runtime state (e.g. cache)** can be mocked or injected.

---

## 4. Test-Driven Development

- Every function must be **unit tested** — no untested logic.
- Every component must have **contract-level integration tests**.
- Prefer:
    
    ```
    ts
    CopyEdit
    // Given input A
    // When we perform operation B
    // Then we expect result C
    
    ```
    
- Tests should live in `/tests` and mirror the source structure.
- Use `Vitest` (or equivalent) as the test runner.

### Testing Patterns Used

- **Unit tests**: Mock external dependencies (pg client, file system)
- **Integration tests**: Test component interaction with mocked I/O
- **Dependency injection**: Constructor injection for testability
- **Event-driven testing**: Verify pub/sub interactions and event sequences

### Run tests locally:

```bash
npm run test             # one-time test run
npm run test -- --watch  # watch mode during dev
```

> No code is considered complete until it has a passing test.

---

## 5. Technical Implementation Details

### 5.1 Materialize Streaming Protocol
* Uses Postgres wire protocol with `SUBSCRIBE` queries
* Implements `pg-query-stream` for real-time row streaming
* Stream format: `{ row: Record<string, any>, diff: number }` (mz_timestamp excluded from cached data)
* Automatic reconnection on connection failures (5s) and stream failures (3s)
* Strips `mz_timestamp` and `diff` metadata columns from Materialize before caching
* Validates view existence before starting streaming operations

### 5.2 Schema Path Resolution
* Schema path resolution supports both Docker and local development:
  - Docker: `./config/schema.sdl` relative to working directory  
  - Local dev: `./config/schema.sdl` relative to project root
  - System automatically detects config directory location

### 5.3 GraphQL Server Configuration
* GraphQL Yoga with WebSocket support (`graphql-ws` protocol)
* Async generator-based subscription resolvers that:
  1. Yield initial snapshot from ViewCache (all current rows)
  2. Subscribe to pub/sub events for live updates
  3. Yield new updates as they arrive from Materialize
* Single endpoint at `/graphql` with WebSocket upgrade support
* Schema loading from static SDL files with path auto-detection
* GraphiQL integration for development
* Specific WebSocket configuration including timeouts and connection limits

### 5.4 View Cache Implementation
* ViewCache preserves insertion order using JavaScript Map data structure
* On update (existing key): replace row in-place, preserving position
* On delete: remove the row from cache
* On insert (new key): append row to end of cache
* In-memory HashMap keyed by primary key field from schema
* Supports insert, update, delete operations based on diff values
* Maintains current state for serving initial snapshots

### 5.5 Schema Validation Implementation
* Regex-based parsing to detect ID! field in SDL schema files
* File system validation for schema file existence
* Validates exactly one data type definition (excluding `type Subscription`)
* Fails fast with helpful error if multiple data types found
* Multiple data types will be supported in future versions
* GraphQL format validation using string parsing
* Detailed error messaging with examples for common mistakes
* Primary key field extraction and caching for view operations

---

## 6. Event Structure and Internal APIs

### Stream Event Format
```typescript
interface StreamEvent {
  row: Record<string, any>;    // The data row from Materialize
  diff: number;                // 1 for insert/update, -1 for delete
}
```

### Event Bus Architecture
* EventEmitter-based pub/sub system for decoupling components
* Dependency injection support for testing with constructor injection
* Max listeners configuration to prevent memory leaks
* Component-specific event namespacing (e.g., 'stream:viewName')

### Internal Event Format
* Internal messages published from the Materialize streaming layer to the GraphQL subscription layer conform to a shared structure aligned with Materialize's `SUBSCRIBE` protocol
* Format: `{ row: Record<string, any>, diff: number }`
* This format preserves compatibility with the source stream and keeps messaging efficient

### Internal Event Types
- `STREAM_CONNECTED`: Materialize connection established
- `STREAM_UPDATE_RECEIVED`: New row update received from stream
- `SCHEMA_LOADED`: GraphQL schema successfully loaded
- `SERVER_READY`: GraphQL server ready to accept connections

### PubSub Interface
```typescript
interface PubSub {
  publishStreamEvent(viewName: string, event: StreamEvent): void;
  subscribeToStream(viewName: string, handler: (event: StreamEvent) => void): void;
  publish(eventType: string, data: any): void;
  subscribe(eventType: string, handler: (data: any) => void): void;
}
```

---

## 7. Logging & Observability

### Structured Logging Implementation
- Component-specific child loggers (e.g., 'materialize', 'viewCache', 'pubsub')
- Structured log format with consistent field naming
- Log levels: `info` for major operations, `debug` for verbose data, `warn`/`error` for failures
- Contextual logging with view names, cache sizes, error details

### Key Log Events
- `stream.connected`, `stream.updateReceived`, `stream.updateParsed`
- Connection establishment and teardown
- Cache operations (insert, update, delete)
- GraphQL subscription lifecycle
- Error categorization (connection vs stream vs validation errors)

---

## 8. Performance

> This system should be efficient — but not at the cost of maintainability (yet).
> 
- In 1.x, **favor clarity over micro-optimization**.
- Avoid tight loops or serialization bottlenecks where possible.
- Benchmark message latency at component boundaries in Milestone 2.