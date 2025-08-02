## **Milestone 1 — Stream Real-Time Data via GraphQL with Minimal Setup** ✅ (In Progress)

> Developers can stream filtered updates from Materialize (views, tables, or any SELECT-able object) into GraphQL clients using a simple YAML schema and local setup.
> 

### ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ WebSocket-based GraphQL Subscriptions using @nestjs/graphql
- ✅ Compatible with Apollo Client and other standard GraphQL clients
- ✅ RxJS Observables throughout for reactive streaming
- ✅ Sends updates for changed fields only

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

### 🔄 Streaming Database Resilience

- Automatic reconnect with exponential backoff
- Cursor-based resume using SUBSCRIBE AS OF to avoid data loss on reconnection
- Circuit breaker for failed subscriptions
- Stream health monitoring and self-healing
- Runtime source existence validation

### 🧠 Server Resilience

- Graceful error handling for GraphQL server failures
- WebSocket reconnection support
- Stale client cleanup and connection lifecycle management
- Standardized error codes for all failure modes
- Graceful shutdown with client notification before disconnect
- Exception filters for consistent error handling across the application

### 🔄 Subscription Lifecycle & Reliability

- Clients know when initial data load is complete vs receiving live updates
- Clients can detect if they missed any updates during brief disconnections
- Recent updates can be replayed for clients that briefly disconnect
- Clear visibility into tycostream's connection health with its data sources

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

### ⏱ Protocol Support & Optimizations

- Update coalescing: batch rapid changes within time windows
- Client-configurable batching strategies (time-based, count-based)
- RisingWave support
- Filter expression normalization for functional equivalency (e.g., `a AND b` vs `b AND a`)

### 🧪 Performance Testing

- Load testing for high-frequency updates and concurrent connections
- Benchmarks for subscription startup latency and memory usage