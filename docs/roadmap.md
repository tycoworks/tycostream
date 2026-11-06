# tycostream Roadmap

## ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ RxJS Observables throughout for reactive streaming
- ✅ Sends updates for changed fields only

## 📊 GraphQL Subscriptions

- ✅ GraphQL Subscriptions over SSE using @nestjs/graphql and GraphQL Yoga
- ✅ Compatible with Apollo Client and other standard GraphQL clients
- ✅ Simple YAML config defining sources and schema
- ✅ GraphQL schema auto-generated from YAML
- ✅ Support for custom GraphQL types and fields
- ✅ Hasura-style filters
- ✅ Multiple sources per database
- ✅ Multiple concurrent clients supported

## 🚀 Developer Experience

- ✅ Start with a single npm run command
- ✅ Hot reload with NestJS development mode
- ✅ Environment-based configuration with validation
- ✅ Docker support with docker-compose for development
- ✅ Subscribe to any configured source in seconds

## Backlog

- [Calculated states](./design/calculated_states.md)
- Row-level security
- [Observability](./design/observability.md)
- [Database reconnection](./design/database_reconnection.md)
- [Client reconnection](./design/client_reconnection.md)