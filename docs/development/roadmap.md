# tycostream Roadmap

## **Milestone 1 — Developer Preview** ✅ (Complete)

> Stream live data from Materialize views over WebSockets and fire webhooks when conditions are met. Not intended for production use. 

### ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ RxJS Observables throughout for reactive streaming
- ✅ Sends updates for changed fields only

### 📊 GraphQL Subscriptions

- ✅ WebSocket-based GraphQL Subscriptions using @nestjs/graphql
- ✅ Compatible with Apollo Client and other standard GraphQL clients
- ✅ Simple YAML config defining sources and schema
- ✅ GraphQL schema auto-generated from YAML
- ✅ Support for custom GraphQL types and fields
- ✅ Hasura-style filters
- ✅ Multiple sources per database
- ✅ Multiple concurrent clients supported

### 🔔 Event Triggers

- ✅ Webhook delivery on data conditions
- ✅ Different fire/clear thresholds (hysteresis support)
- ✅ GraphQL mutations for trigger management
- ✅ In-memory trigger storage (ephemeral)

### 🚀 Developer Experience

- ✅ Start with a single npm run command
- ✅ Hot reload with NestJS development mode
- ✅ Environment-based configuration with validation
- ✅ Docker support with docker-compose for development
- ✅ Subscribe to any configured source in seconds

---

## **Milestone 2 — MVP (Minimal Viable Product)**

> Deploy tycostream in production with authentication, data integrity guarantees, and reliable webhook delivery.

### 🔐 Basic Authentication & Authorization

- JWT-based authentication with signature verification
- Basic authorization (JWT can access specific sources/operations)
- Simple deny-by-default policy enforcement

### 🩺 Essential Observability

- Health check endpoints (/health, /ready)
- Prometheus metrics endpoint with key metrics
- Structured error logging

### 🔔 [Webhook Reliability](./features/webhook_reliability.md)

- At-least-once delivery with exponential backoff
- Dead letter queue for failed webhooks
- Basic idempotency support (event IDs)
- Error webhooks for stream disconnection events (notify when connection lost/restored)

### 🧠 [Database Resilience](./features/database_reconnection.md)

- Graceful error handling without process crashes
- Automatic reconnect to Materialize with resume from last position (no data loss)
- Connection state preservation during disconnects
- Client notifications for connection state changes

### 🔌 [Client Resilience](./features/client_reconnection.md)

- WebSocket reconnection support
- Basic connection lifecycle management
- Bounded per-subscriber queues (prevent memory exhaustion)
- Basic drop policy for slow consumers

---

## **Milestone 3 — Enterprise Features**

> Deploy tycostream at scale with advanced security, complete observability, and extended database support.

### 🔗 Extended Data Capabilities

- GraphQL joins
- RisingWave support alongside Materialize
- Multiple concurrent database connections

### 🔐 Advanced Security

- Full RBAC for GraphQL operations
- Row-level security with deny-by-default edge filtering
- Query complexity analysis to prevent expensive operations
- Field-level middleware for auth and logging
- JWKS support with key rotation

### 🩺 Full Observability

- Grafana dashboards and alerting rules
- Distributed tracing support (OpenTelemetry)
- Audit trail of data sent to each connected client
- Performance metrics per subscription

### 🔄 Advanced Resilience

- Circuit breaker for failed subscriptions
- Stream health monitoring and self-healing
- Runtime source existence validation
- Graceful degradation during partial outages
- Automatic failover between streaming databases

### 🔔 Advanced Triggers

- Webhook signatures (HMAC) for security
- Cooldown periods and rate limiting
- Parameterized conditions with runtime variables
- Webhook retry policies with jitter
- Trigger persistence (survive restarts)
- Time-to-live (TTL) and expiration
- Query matched rows for debugging
- Trigger audit trail and metrics
- Field selection for webhook payloads

### 🧠 Production Hardening

- Standardized error codes for all failure modes
- Graceful shutdown with client notification before disconnect
- Memory leak prevention and monitoring

### 🔄 [Advanced Client Features](./features/client_reconnection.md#enterprise-features-future)

- Advanced backpressure strategies (adaptive buffers, per-client QoS)
- Configurable drop policies with multiple strategies
- Session management with replay capabilities
- Connection quality metrics and dashboards
- Client-specific throttling and rate limiting

### 🧪 Comprehensive Testing

- Resilience test suite for failure scenarios
- Performance/stress test suite for high throughput
- Chaos engineering test scenarios

---

## **Milestone 4 — Scale to High-Throughput Workloads**

> Stream high-frequency data to many clients while monitoring performance, avoiding overload, and tuning system behavior.

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

### ⏱ Performance Optimizations

- Update coalescing: batch rapid changes within configurable time windows
- Client-configurable batching strategies (time-based, count-based)
- Async view processing to prevent blocking event loop during filtering
- Field filtering: send only primary key for DELETE, only changed fields for UPDATE (reduce network traffic)

### 🧪 Performance Testing

- Load testing for high-frequency updates and concurrent connections
- Benchmarks for subscription startup latency and memory usage