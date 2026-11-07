# Architecture

## Overview

tycostream turns database views into GraphQL subscriptions. Each view in `schema.yaml` becomes a subscription; each client's subscription is pushed down to Materialize as its own `SUBSCRIBE` of a filtered `SELECT`, so Materialize does the filtering and the snapshot, and tycostream holds no rows beyond the changes it's passing on.

The design and its reasons are in [design/hollow-out.md](./design/hollow-out.md).

## Technology Stack

- **Runtime**: Node.js with TypeScript, as ES modules
- **Framework**: NestJS for modules and dependency injection
- **GraphQL Server**: @nestjs/graphql with GraphQL Yoga (subscriptions over SSE)
- **Database Client**: node-postgres (Materialize speaks the Postgres wire protocol)
- **SQL**: Kysely, used only to compile filters to SQL with bind parameters
- **Streaming**: Repeater (async iterators that clean up as soon as the client goes)
- **Schema**: GraphQL schema generated at startup from `schema.yaml`
- **Configuration**: @nestjs/config with class-validator

## Component Architecture

Three layers, each a Nest module that depends only on the one below.

### Database Module (`src/database/`)

Connections and the Materialize protocol. Nothing above it sees SQL or how Materialize reports changes.

- **`DatabaseStreamService`** opens one stream per subscription. It compiles the client's `where` to SQL (`query.ts`), picks the protocol handler, and closes any open streams on shutdown.
- **`DatabaseStream`** (`stream.ts`) owns one connection: it opens it on the first read, hands it to the protocol handler, passes on what the handler yields, and closes it when the client stops. It assumes only the Postgres wire protocol.
- **`MaterializeProtocolHandler`** (`materialize.ts`) says everything that's said over that connection: `DECLARE … CURSOR FOR SUBSCRIBE (…) WITH (SNAPSHOT, PROGRESS)`, the `FETCH` loop, typing each column as the schema says, holding a timestamp's rows until a progress row passes it, and pairing them into insert, update and delete events.

The contract between this layer and the next is `ProtocolHandler.read`: tycostream's row events, one complete timestamp at a time. Another database would be another protocol handler.

### View Module (`src/view/`)

The domain layer. `ViewService` is a pass-through to the database layer for now; it's where a shared cache, filtering in memory, or permissions would go.

### API Module (`src/api/`)

- Generates the GraphQL schema from `schema.yaml`: a type, an update type and a filter input per view.
- `SubscriptionService` passes the client's `where` down, and turns each event into a GraphQL update, sending only the fields the event names.
- The resolvers hand GraphQL the service's iterator directly, so a client that disconnects closes its database connection at once.

### Configuration & Common (`src/config/` and `src/common/`)

- Database and GraphQL settings, validated at startup
- `schema.yaml` loading and validation
- The `where` operators and row events the layers share
- Logging helpers

## Data Flow

1. **A client subscribes** over SSE, with an optional `where`.
2. **The filter becomes SQL.** The `where` passes through the view layer to `DatabaseStreamService`, which compiles it to `SELECT … WHERE …` with its values as bind parameters. An invalid filter fails here, before any connection opens.
3. **The client gets its own connection and `SUBSCRIBE`.** Materialize sends the matching rows as of one timestamp (the snapshot), then every change after it, with a progress row whenever a timestamp is complete.
4. **Each complete timestamp becomes events.** Identical rows are netted, then each key's −1 and +1 are paired: a +1 alone is an insert, a −1 alone a delete, both an update of the columns that differ. A row entering or leaving the client's filter arrives as a lone +1 or −1, so it's an insert or a delete.
5. **The client gets each event** as a GraphQL update. A slow client holds the next `FETCH` back, so its backlog queues in Materialize, which caps it.
6. **The client disconnects,** and its connection closes, which drops the `SUBSCRIBE` in Materialize.

A database error, or a view whose key turns out not to be unique, ends that one subscription with a GraphQL error. The server keeps running.

## Key Design Decisions

The full list is in [design/hollow-out.md](./design/hollow-out.md#decisions). The main ones:

### Why one `SUBSCRIBE` per client?

- Materialize already filters, snapshots and orders changes per query; tycostream doesn't have to repeat it.
- No shared cache means no late-joiner races and no copy of every row in tycostream.
- The cost moves to Materialize: a connection and a dataflow per client. Serve indexed or materialized views, so each subscription doesn't recompute its view from scratch.

### Why raw diffs and progress rows?

- The −1 carries the old row, so updates and deletes need no cache.
- Waiting for progress means a client never sees half a timestamp.

### Why `Repeater` and not RxJS?

- A `Repeater` cleans up the moment the client goes, even on a quiet view, and its `push` waits for the client, so a slow client's backlog stays in Materialize.
- RxJS can come back for sharing between clients, which is what it's good at.

### Why single process?

- Less to operate; Materialize does the heavy lifting and scales on its own.

## Future Evolution

- **Queries per view** through a connection pool: [design/queries.md](./design/queries.md)
- **Sharing between clients** with identical or overlapping filters, model-checked
- **Permissions** in the view layer
- **Monitoring**: OpenTelemetry instrumentation points
