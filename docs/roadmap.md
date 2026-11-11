# tycostream Roadmap

## ⚙️ Core Streaming Infrastructure

- ✅ NestJS modular architecture: GraphQL + stream ingestion with dependency injection
- ✅ Snapshot + incremental live updates via Materialize `SUBSCRIBE`
- ✅ Each client's selection pushed down to Materialize as its own `SUBSCRIBE`
- ✅ One message per timestamp: a client never sees half a transaction
- ✅ Sends updates for changed fields only
- ✅ A database error ends one subscription, not the server

## 📊 GraphQL API

- ✅ [Queries](./design/queries.md) and subscriptions per source, over SSE, using @nestjs/graphql and GraphQL Yoga
- ✅ Compatible with Apollo Client and other standard GraphQL clients
- ✅ GraphQL schema auto-generated from a YAML config of sources
- ✅ [Hasura-compatible](./design/hasura_compatibility.md) names, scalars and operators
- ✅ `where`, `order_by`, `limit` and `offset`
- ✅ Enums, with ordering
- ✅ Multiple sources per database, and many concurrent clients

## 🚀 Developer Experience

- ✅ Environment-based configuration with validation
- ✅ Docker image, for amd64 and arm64

## Backlog

- **Relationships between sources** (in progress, [#2](https://github.com/tycoworks/tycostream/issues/2)): nested GraphQL fields, such as a position's trades, each pushed down to Materialize as one `SUBSCRIBE` of a join, so every level of the result stays at one timestamp. The main reason for the hollow-out.
- **Arrays, as GraphQL lists** (parked): node-postgres already parses them into lists; arrays of timestamps and dates need their own conversions, and Hasura's handling needs checking first
- **Column types read from the database at startup,** with Kysely's built-in catalog reader, as kysely-codegen does, so `schema.yaml` declares only keys and enums
- **A redesigned stress test:** the current one was written for the shared cache, before the hollow-out, so it needs redesigning for one `SUBSCRIBE` per client before it runs in CI
- Row-level security
- [Observability](./design/observability.md)
- Database reconnection
- [Client reconnection](./design/client_reconnection.md)
