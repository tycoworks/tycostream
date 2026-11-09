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

- ✅ Start with a single npm run command
- ✅ Hot reload with NestJS development mode
- ✅ Environment-based configuration with validation
- ✅ Docker support with docker-compose for development
- ✅ Subscribe to any configured source in seconds

## Backlog

- **Relationships between sources:** nested GraphQL fields, such as a position's trades, each pushed down to Materialize as one `SUBSCRIBE` of a join, so every level of the result stays at one timestamp. The main reason for the hollow-out.
- **Arrays, as GraphQL lists** (parked): node-postgres already parses them into lists; arrays of timestamps and dates need their own conversions, and Hasura's handling needs checking first
- **Column types read from the database at startup,** with Kysely's built-in catalog reader, as kysely-codegen does, so `schema.yaml` declares only keys and enums
- Row-level security
- [Observability](./design/observability.md)
- Database reconnection
- [Client reconnection](./design/client_reconnection.md)
