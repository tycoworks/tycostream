## **Milestone 1 — Stream Real-Time Data via GraphQL with Minimal Setup** ✅ (In Progress)

> Developers can stream filtered updates from Materialize (views, tables, or any SELECT-able object) into GraphQL clients using a simple YAML schema and local setup.
> 

### ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ WebSocket-based GraphQL Subscriptions using @nestjs/graphql
- ✅ Compatible with Apollo Client and other standard GraphQL clients
- ✅ RxJS Observables throughout for reactive streaming

### 📝 Schema & Configuration

- ✅ Simple YAML config defining sources and schema
- ✅ GraphQL schema auto-generated from YAML
- ✅ Support for custom GraphQL types and fields
- 🔄 Hasura-style filters (next phase)
- 🔄 Nested queries based on relational joins (next phase)
- ✅ Multiple sources per database
- ✅ Multiple concurrent clients supported

### 🚀 Dev Experience

- ✅ Start with a single npm run command
- ✅ Hot reload with NestJS development mode
- ✅ Environment-based configuration with validation
- ✅ Docker support with docker-compose for development
- ✅ Subscribe to any configured source in seconds

---

## **Milestone 2 — Deploy tycostream Securely in Production**

> Teams can run tycostream in production with authentication, access control, observability, and fault tolerance.
> 

### 🔐 Access & Security

- JWT-based authentication
- Role-based access control (RBAC) for GraphQL operations
- Row-level entitlements for secure data access per user

### 🩺 Observability

- Prometheus metrics
- Health check endpoints
- Structured logs for query and stream activity
- Full audit trail of data sent to each connected client

### 🔄 Materialize Resilience

- Automatic reconnect with exponential backoff
- Circuit breaker for failed subscriptions
- Stream health monitoring and self-healing
- Runtime source existence validation

### 🧠 Server Resilience

- Graceful error handling for GraphQL server failures
- WebSocket reconnection support
- Stale client cleanup and connection lifecycle management
- Standardized error codes for all failure modes

### 🧪 Test Infrastructure

- ✅ Integration test suite using testcontainers with real Materialize instance
- ✅ Comprehensive E2E tests covering all CRUD operations, data types, and concurrent connections
- 🔄 Resilience test suite for failure scenarios and fail-fast behavior validation
- 🔄 Performance/stress test suite for high throughput and concurrent connection scenarios

---

## **Milestone 3 — Scale to High-Throughput Workloads and Multi-Client Fanout**

> Teams can confidently stream high-frequency data to many clients while monitoring performance, avoiding overload, and tuning system behavior.
> 

### 📈 Scalability

- Redis or NATS-based pub/sub layer for fan-out
- Multiplexed subscriptions across clients to avoid duplicate stream loads
- Pagination support for large result sets
- Decoupling of GraphQL and Materialize processes for horizontal scaling
- Performance instrumentation for stream latency and throughput

### 🧹 Backpressure & Caching

- Clear cache and close DB connection when last subscriber disconnects
- Memory pressure monitoring
- Graceful degradation during overload or outages

### ⏱ Protocol Optimizations

- Update coalescing: batch rapid changes within time windows
- Client-configurable batching strategies (time-based, count-based)
- Delta updates: send only changed fields instead of full rows

### 🧪 Performance Testing

- Load testing for high-frequency updates and concurrent connections
- Benchmarks for subscription startup latency and memory usage

---

## **Milestone 4 — Use tycostream as a Managed Streaming GraphQL Platform**

> Teams can use tycostream as a hosted service with token-based access, admin tooling, and integrations with downstream GraphQL ecosystems.
> 

### ☁️ Hosted Platform

- Fully managed, SLA-backed tycostream service
- Token-based access authentication
- Admin UI for source config and schema management

### 🔌 Ecosystem Integration

- Support for Live Queries over SSE
- Hasura-compatible schema introspection and metadata format

### 🔄 Multi-Source Support

- Native RisingWave backend support
- Multi-source deployment: Materialize + RisingWave in one config