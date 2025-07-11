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
- `/config/` – YAML schemas and metadata config
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

## 5. Dependency Management and Reuse Principle

**CRITICAL: Prefer well-established libraries over custom implementations**

- **Never reinvent the wheel**: If a mature, well-maintained library exists for a common task, use it
- **Examples of what NOT to implement ourselves**:
  - Logging (use Pino, Winston, etc.)
  - HTTP servers (use Express, Fastify, etc.) 
  - Database clients (use official clients)
  - Date/time manipulation (use date-fns, dayjs)
  - Validation (use Zod, Joi, etc.)
  - Async queues (use p-queue, async, etc.)
  - YAML parsing (use js-yaml, yaml, etc.)
- **When custom implementation is acceptable**:
  - Core business logic specific to our domain
  - Simple utilities where a library would be overkill
  - Performance-critical paths where libraries add unnecessary overhead
- **Research first**: Before writing any utility function, search npm for existing solutions
- **Document decisions**: If choosing custom implementation, document why in code comments

---

## 5.1. Code Duplication and Constants Management

**CRITICAL: Eliminate code duplication and magic numbers**

- **No duplicate code fragments**: Never copy-paste code blocks or repeat similar logic across files
- **No magic numbers**: All numeric values must be named constants with clear documentation
- **No hardcoded strings**: Repeated string literals must be extracted to constants
- **Component-local constants**: Keep configuration values close to where they're used
- **Examples of component-local constants**:
  - Connection timeouts in database modules
  - Limits and thresholds in cache modules
  - Default values in server configuration
  - Component-specific timing values
- **Constants best practices**:
  - Use `const` assertions for immutable configuration: `as const`
  - Document why values are chosen: "10ms provides responsive UI without excessive CPU usage"
  - Keep constants private unless they need to be exported for testing
  - Avoid global constants files that create artificial coupling
- **Refactoring approach**: When you notice similar code in 2+ places, immediately extract to a shared utility
- **Shared utilities acceptable**: Helper functions, test utilities, and cross-cutting concerns can be centralized

---

## 6. Test-Driven Development
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

### Critical Test Scenarios
- **Order preservation**: Updates delivered in Materialize stream order
- **Early client connection**: Client connects before any data arrives from Materialize
- **Mid-stream client connection**: Client connects while data is actively streaming
- **Concurrent client isolation**: Multiple clients receive independent streams
- **Update queuing**: Updates queue properly when client is receiving initial state

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
* Column structure determined from YAML schema field definitions (no database introspection required)
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

### 6.3 Configuration Validation
* **Library**: Zod - TypeScript-first schema validation library for robust environment variable validation
* Environment schema defined with type transforms (string → number for ports)
* Built-in validation rules (port ranges, required fields, enum values for log levels)
* Better error messages with examples and actionable guidance
* Test-friendly caching (disabled in test environment for dynamic validation)
* Helper functions: `getGraphQLPort()`, `isGraphQLUIEnabled()`, `getLogLevel()` centralize env var access

### 6.4 Schema Path Resolution
* Path resolution logic implemented in `findConfigRoot()` function
* Config directory detection using `process.cwd()` and `existsSync()` checks

### 6.4.1 View Name Resolution
* YAML schema parsing extracts view definitions from configuration structure
* Single view validation ensures exactly one view definition per schema file
* View name and database view mapping extracted from YAML structure

### 6.5 GraphQL Server Configuration
* Implementation details for the GraphQL API Server described in [ARCHITECTURE.md](ARCHITECTURE.md#graphql-api-server-graphql-yoga)
* GraphQL Yoga server implementation with `createYoga()` and WebSocket configuration
* Async generator-based subscription resolvers using `buildSchema()` from GraphQL
* WebSocket server implementation using `WebSocketServer` from `ws` package
* Optional GraphQL UI controlled by `GRAPHQL_UI` environment variable (disabled by default)

### 6.6 Central View Cache Implementation
* Implementation details for the Central View Cache component described in [ARCHITECTURE.md](ARCHITECTURE.md#central-view-cache)
* Lock-free in-memory Map keyed by primary key field (ID!) from schema
* Supports concurrent read access from multiple Client Stream Handlers
* Row operations: insert (new row), update (replace existing), delete (remove row)
* Subscriber management with callback registration pattern
* Emits typed events: `RowUpdateEvent` with diff type and row data

### 6.6.1 Single-Subscribe Architecture
* **Unified event stream**: Current state + live updates flow through single subscription path
* **Consistent delivery**: New subscribers immediately receive current state as individual events
* **Event ordering**: All events (current state + live updates) maintain strict Materialize ordering
* **Simplified concurrency**: Single event queue per client provides clean event processing

### 6.6.2 Client Stream Handler Implementation
* Each GraphQL subscription creates an isolated Client Stream Handler
* Uses p-queue library for robust async task management
* Current state delivered as individual 'insert' events on subscription
* Live updates continue seamlessly through same event stream
* Proper cleanup on client disconnect prevents memory leaks

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
- **Library**: Pino - high-performance JSON logger with structured logging capabilities
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