# Observability

## Overview

This document outlines the observability features for tycostream, covering health checks, metrics, logging, and monitoring capabilities needed for production deployments. Features are organized by milestone.

## Milestone 2 — MVP

### Health Endpoint

- **`/health`** - Basic application health status
  - Returns 200 if healthy, 503 if unhealthy
  - Checks database connection status
  - Uses NestJS `@nestjs/terminus`

### Basic Metrics

Expose essential metrics via `/metrics` endpoint using `prom-client`:

#### View Metrics
**Current Issue**: Views currently dispose themselves, making tracking difficult. Need to refactor view lifecycle management to maintain registry.

```
tycostream_views_active_total          # Number of active views
tycostream_views_created_total         # Total views created
tycostream_views_disposed_total        # Total views disposed
tycostream_views_rows_processed_total  # Rows processed per view
tycostream_views_filter_time_seconds   # Time spent filtering
```

#### Client Metrics
```
tycostream_clients_connected           # Currently connected clients
tycostream_clients_subscriptions_total # Active subscriptions per client
tycostream_clients_buffer_size         # Replay buffer size per client
tycostream_clients_buffer_drops_total  # Dropped messages due to buffer overflow
tycostream_clients_bytes_sent_total    # Bytes sent to each client
tycostream_clients_messages_sent_total # Messages sent to each client
tycostream_clients_slow_consumer_total # Clients marked as slow consumers
```

#### Source Metrics
```
tycostream_sources_active              # Active source connections
tycostream_sources_rows_received_total # Rows received from Materialize
tycostream_sources_snapshot_duration   # Time to complete initial snapshot
tycostream_sources_lag_seconds         # Lag between source and processed
tycostream_sources_cache_hits_total    # Cache hit rate per source
tycostream_sources_cache_size_bytes    # Memory used by source cache
```

#### Database Metrics
```
tycostream_db_connections_active       # Active database connections
tycostream_db_connections_idle         # Idle connections in pool
tycostream_db_query_duration_seconds   # Query execution time
tycostream_db_errors_total             # Database errors by type
tycostream_db_reconnects_total         # Database reconnection attempts
```

#### Trigger Metrics
```
tycostream_triggers_active             # Active triggers
tycostream_triggers_fired_total        # Triggers fired by name
tycostream_triggers_webhook_success    # Successful webhook deliveries
tycostream_triggers_webhook_failures   # Failed webhook deliveries
tycostream_triggers_webhook_duration   # Webhook delivery time
```

### Business Metrics

```
tycostream_subscription_start_latency  # Time to start subscription
tycostream_event_processing_latency    # End-to-end event latency
tycostream_subscription_error_rate     # Errors per subscription
```

## Logging

### Audit Logging (MVP)

For MVP, audit logging uses a separate file transport:

```typescript
// Separate audit.log file for security events
- Client connections/disconnections
- Subscription creation/deletion  
- Authentication attempts
- Authorization denials
```

Implementation: Use Winston or similar with multiple transports to write audit events to a dedicated file.

## Milestone 3 — Enterprise Features

### Advanced Health Checks

- **`/ready`** - Kubernetes readiness probe
- **Additional health indicators**:
  - MemoryHealthIndicator
  - DiskHealthIndicator
  - ViewSystemHealthIndicator

### Full Metrics Suite

Extended metrics beyond MVP basics:
- Detailed view lifecycle metrics
- Advanced client buffer analytics
- Business metrics and SLAs
- Performance histograms

### Structured Logging

Upgrade from basic file logging to structured logging:

```typescript
logger.log({
  level: 'info',
  message: 'Subscription started',
  context: {
    clientId: '123',
    subscription: 'trades',
    filters: {...}
  }
});
```

### Advanced Audit Logging

- Ship to SIEM or compliance database
- Tamper-evident storage
- Detailed data access patterns

### Distributed Tracing

### OpenTelemetry Integration

For Milestone 3, add distributed tracing:

```typescript
// Trace spans for:
- GraphQL request processing
- Database queries
- View filtering
- Webhook delivery
- Cache operations
```

## Implementation Notes

### View Lifecycle Management

Current issue: Views dispose themselves, making metrics tracking difficult.

**Solution**:
1. Implement ViewRegistry to track all active views
2. Views register on creation, deregister on disposal
3. Registry exposes metrics for monitoring
4. Add reference counting for shared views

### Client Buffer Monitoring

Track replay buffer health:
1. Monitor buffer size per client
2. Alert on buffer overflow
3. Track slow consumer patterns
4. Implement adaptive buffering based on metrics

### Resource Monitoring

Critical resources to monitor:
- Memory usage (especially for caches)
- CPU usage (filtering operations)
- Network I/O (WebSocket traffic)
- Disk I/O (if logging to disk)

## Dashboards (Milestone 3)

### Grafana Dashboards

Create dashboards for:
1. **System Health**: Overall health, uptime, errors
2. **Performance**: Latencies, throughput, bottlenecks
3. **Client Analytics**: Connections, subscriptions, data flow
4. **Resource Usage**: Memory, CPU, network, disk
5. **Business Metrics**: Usage patterns, popular queries

## Alerting Rules

### Critical Alerts
- Database connection lost
- Memory usage > 90%
- Error rate > 1%
- No active views (possible leak)

### Warning Alerts
- Slow consumer detected
- High buffer usage
- Increased latency
- Failed webhook deliveries

## Development vs Production

### Development Mode
- Verbose logging
- All metrics exposed
- No sampling
- Debug endpoints enabled

### Production Mode
- Structured logging only
- Sampled metrics
- Security-sensitive data redacted
- Performance optimized

## NestJS Built-in Features

Leverage NestJS built-in observability:
- HTTP request logging middleware
- Exception filters with logging
- Interceptors for performance monitoring
- Guards for audit logging
- Terminus for health checks

## Future Enhancements

- Custom metrics exporter
- Real-time metrics dashboard
- Anomaly detection
- Predictive scaling based on metrics
- Cost tracking and optimization