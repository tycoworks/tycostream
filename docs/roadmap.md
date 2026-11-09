# tycostream Roadmap

## ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ Each client's filter pushed down to Materialize as its own `SUBSCRIBE`
- ✅ Whole timestamps only: a client never sees half a transaction
- ✅ Sends updates for changed fields only
- ✅ A database error ends one subscription, not the server

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

- [Queries per source](./design/queries.md)
- **Relationships between sources:** nested GraphQL fields, such as a position's trades, each pushed down to Materialize as one `SUBSCRIBE` of a join, so every level of the result stays at one timestamp. The main reason for the hollow-out.
- `limit`, `offset` and `order_by` for queries
- **Arrays, as GraphQL lists:** dropped while tycostream moved to Postgres's own types; parsing by the database's types turns them into lists already
- **Column types read from the database at startup,** with Kysely's built-in catalog reader, as kysely-codegen does, so `schema.yaml` declares only keys and enums
- [Calculated states](./design/calculated_states.md)
- Row-level security
- [Observability](./design/observability.md)
- Database reconnection
- Timestamps on updates, so a client can apply each timestamp whole
- [Client reconnection](./design/client_reconnection.md)