# tycostream Roadmap

## **Milestone 1 — Developer Preview** (In Progress)

**Target:** Any developer exploring streaming (see [positioning doc](../marketing/positioning.md))  
**Goal:** Stream live data from Materialize views over WebSockets and fire webhooks when conditions are met. Not intended for production use. 

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

### 🧮 [Calculated States](./features/calculated_states.md)

- Define state enums in YAML configuration
- Runtime evaluation of state conditions per subscription
- Type-safe GraphQL enums for state fields
- Connection-aware alternative to webhook triggers

---

## **Milestone 2 — MVP (Minimal Viable Product)**

**Target:** Full-stack developers building a single application (see [positioning doc](../marketing/positioning.md#use-case-a-application-component-current-focus))  
**Goal:** Run tycostream as part of a production application with essential authentication, observability, and resilience.

### 🔐 Basic Authentication & Authorization

- Simple JWT verification with shared secret
- Basic RBAC for GraphQL operations
- Source-level access control via JWT claims
- Deny-by-default policy

### 🩺 [Essential Observability](./features/observability.md#milestone-2-mvp)

- Health check endpoint (/health)
- Prometheus metrics for core operations
- Audit logging to separate file

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

## **Milestone 3 — Enterprise Deployment**

**Target:** Infrastructure/platform teams integrating tycostream into enterprise environments  
**Goal:** Integrate tycostream with enterprise infrastructure for security, observability, and deployment.

### 🔌 Enterprise Integration

- **Security**: Row-level security with deny-by-default edge filtering
- **Security**: JWKS support with key rotation
- **Security**: Query complexity analysis to prevent expensive operations
- **Observability**: OpenTelemetry integration for distributed tracing
- **Observability**: Prometheus metrics exportable to Grafana/Datadog
- **Observability**: Performance metrics per subscription
- **Audit**: Integration with enterprise logging systems (Splunk, ELK, etc.)
- **Audit**: Audit trail of data access per client
- **Data**: GraphQL joins across sources
- **Data**: RisingWave support alongside Materialize

### 🚀 Performance & Scale

- **Scalability**: Redis or NATS-based pub/sub layer for fan-out
- **Scalability**: Multiplexed subscriptions to avoid duplicate stream loads
- **Scalability**: Horizontal scaling via GraphQL/Materialize process separation
- **Scalability**: Pagination support for large result sets
- **Performance**: Update coalescing with configurable time windows
- **Performance**: Client-configurable batching strategies
- **Performance**: Async view processing to prevent blocking
- **Performance**: Stream latency and throughput instrumentation
- **Backpressure**: Advanced strategies (adaptive buffers, per-client QoS)
- **Backpressure**: Configurable drop policies with multiple strategies

### 🛡️ Production Hardening

- **Resilience**: Circuit breaker for failed subscriptions
- **Resilience**: Stream health monitoring and self-healing
- **Resilience**: Automatic failover between streaming databases
- **Resilience**: Graceful degradation during partial outages
- **Triggers**: At-least-once delivery with retries and DLQ
- **Triggers**: Persistent triggers that survive restarts
- **Triggers**: Webhook signatures (HMAC) and authentication
- **Client**: Session management with replay capabilities
- **Client**: Connection quality metrics and dashboards
- **Client**: Client-specific throttling and rate limiting
- **Operations**: Standardized error codes for all failure modes
- **Operations**: Graceful shutdown with client notification
- **Operations**: Memory leak prevention and monitoring

### 🚀 Deployment & Operations

- **Kubernetes**: Helm charts and deployment templates
- **Kubernetes**: ConfigMaps and Secrets integration
- **Cloud**: AWS/GCP/Azure deployment patterns
- **Deployment**: Blue-green deployment support
- **Deployment**: Cross-region deployment patterns
- **Testing**: Resilience test suite for failure scenarios
- **Testing**: Performance/stress test suite for high throughput
- **Testing**: Chaos engineering test scenarios

---

## **Milestone 4 — API Platform**

**Target:** Platform/infrastructure teams building centralized API layers (see [positioning doc](../marketing/positioning.md#use-case-b-api-platform-future-vision))  
**Goal:** Deploy tycostream as a centralized API platform for exposing streaming data across an organization.

### 🏢 Multi-Team Support

- Multiple concurrent database connections
- Source-level access control and team isolation
- Centralized configuration management
- API versioning and deprecation support

### 🔐 Platform Security

- Multi-tenant isolation
- API rate limiting per consumer/team
- Team-based permissions management

### 📊 Platform Management

- Admin APIs for configuration and monitoring
- Usage metrics and billing integration hooks
- SLA monitoring and alerting
- Self-service portal for team onboarding
- Federation across multiple tycostream instances