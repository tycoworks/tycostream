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

## 4. Encapsulation Guidelines
- **Hide implementation details**: User-facing APIs (environment variables, configuration) should not expose underlying technology choices
- **Generic naming**: Use `GRAPHQL_UI` instead of `ENABLE_GRAPHIQL`, `GRAPHQL_PORT` instead of `NODE_PORT`
- **Technology-agnostic interfaces**: Users should not need to know we use GraphQL Yoga, Node.js, or specific npm packages
- **Internal documentation exception**: Implementation files may reference specific technologies for developer guidance

---

## 5. Test-Driven Development
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

## 6. Technical Implementation Details
### 6.1 Materialize Streaming Protocol
* Implementation details for the Backend Service described in [ARCHITECTURE.md](ARCHITECTURE.md#backend-service)
* Uses Postgres wire protocol with `COPY (SUBSCRIBE TO view WITH (SNAPSHOT)) TO STDOUT` via `pg-copy-streams`
* Stream format: `{ row: Record<string, any>, diff: number }`
* Tab-separated COPY output parsing with proper null handling (`\N`)
* Column structure determined from SDL schema field definitions (no database introspection required)
* Metadata column handling (`mz_timestamp`, `diff`) and view validation

### 6.1.1 Error Handling Implementation
* Technical implementation uses `process.exit(1)` for immediate termination
* Graceful shutdown sequence implemented: close GraphQL subscriptions, then close database connection
* Structured error logging with context (view name, error type, debug info)
* Async error handlers coordinate shutdown between MaterializeStreamer and GraphQLServer

### 6.2 Logging Strategy
* **ERROR**: System failures, connection loss, startup failures requiring immediate attention
* **WARN**: Invalid data received, recoverable issues, configuration problems
* **INFO**: Business events (startup/shutdown, GraphQL operations, connection state changes)
* **DEBUG**: Internal mechanics (stream parsing, cache updates, pub/sub events)

#### What We Log:
* **System Lifecycle**: startup, shutdown, component initialization
* **Database Operations**: connection state, query execution, streaming status
* **GraphQL Operations**: HTTP requests, query parsing, subscription management
* **Data Flow**: stream events (sampled to reduce noise), cache updates, pub/sub events
* **Error Conditions**: failures with full context for debugging

#### Debug vs Production:
* DEBUG level logs stream processing details
* INFO level captures key business events visible in production
* Component-based logging with structured JSON for observability tools

### 6.2 Schema Path Resolution
* Path resolution logic implemented in `findConfigRoot()` function
* Config directory detection using `process.cwd()` and `existsSync()` checks

### 6.2.1 View Name Resolution
* Implementation uses `extractViewName()` function with regex parsing
* Regex pattern `/type\s+(\w+)\s*\{/` extracts type names from SDL
* Filters out `type Subscription` definitions to find data types only

### 6.3 GraphQL Server Configuration
* Implementation details for the GraphQL API Server described in [ARCHITECTURE.md](ARCHITECTURE.md#graphql-api-server-graphql-yoga)
* GraphQL Yoga server implementation with `createYoga()` and WebSocket configuration
* Async generator-based subscription resolvers using `buildSchema()` from GraphQL
* WebSocket server implementation using `WebSocketServer` from `ws` package
* Optional GraphQL UI controlled by `GRAPHQL_UI` environment variable (disabled by default)

### 6.4 View Cache Implementation
* Implementation details for the View Cache component described in [ARCHITECTURE.md](ARCHITECTURE.md#view-cache)
* ViewCache preserves insertion order using JavaScript Map data structure
* Row operations: insert (append), update (replace in-place), delete (remove)
* In-memory HashMap keyed by primary key field extracted from schema

### 6.5 Schema Validation Implementation
* Regex-based parsing to detect ID! field in SDL schema files
* File system validation for schema file existence
* Validates exactly one data type definition (excluding `type Query` and `type Subscription`)
* Fails fast with helpful error if multiple data types found
* Multiple data types will be supported in future versions
* GraphQL format validation using string parsing
* Detailed error messaging with examples for common mistakes
* Primary key field extraction and caching for view operations

---

## 7. Event Structure and Internal APIs
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

## 8. Logging & Observability
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

### Log Message Format Standards
- Use structured logging with consistent field naming
- No emojis in log messages (professional output)
- Consistent punctuation: use commas instead of dashes for message flow
- Remove unnecessary adverbs like "successfully" - actions either complete or fail
- Component-specific child loggers maintain context automatically

### Log Message Content Principles
- **No technical jargon**: Avoid terms like "unhandled promise rejection", "uncaught exception", "SUBSCRIBE query"
- **User-facing language**: Use "database connection", "view streaming", "unexpected error" instead
- **Actionable guidance**: Include next steps users should take ("restart tycostream", "check .env file")
- **Context-aware**: Provide specific suggestions based on the error scenario
- **Clear exit reasons**: Explain why tycostream is shutting down and how to resume service

---

## 9. Performance
> This system should be efficient — but not at the cost of maintainability (yet).
> 
- In 1.x, **favor clarity over micro-optimization**.
- Avoid tight loops or serialization bottlenecks where possible.
- Benchmark message latency at component boundaries in Milestone 2.