# Architecture

## Overview

tycostream turns database views into GraphQL queries and subscriptions. Each source in `schema.yaml` gets a query of its current rows, and a subscription to them and every change. A client's selection (its columns, `where`, `order_by`, `limit`, and `offset`) becomes one `SELECT`, which a query runs as it is and a subscription runs inside its own `SUBSCRIBE`. So Materialize filters, sorts, keeps each window, and takes the snapshot, and tycostream holds no rows beyond the changes it's passing on.

**Sources, views and streams.** A *source* is whatever tycostream reads from: a table or view in the database, as listed in `schema.yaml`. (Not a Materialize `SOURCE`, which brings data into Materialize.) A *view* is one client's window onto a source: a source plus a selection. A *stream* is one running read of a view, in a mode: `Snapshot` (the current rows, then it ends) or `Live` (the current rows, then every change). Only the API speaks of queries and subscriptions; below it, a GraphQL query is a `Snapshot` stream and a subscription a `Live` one.

## Technology Stack

- **Runtime**: Node.js with TypeScript, as ES modules
- **Framework**: NestJS for modules and dependency injection
- **GraphQL Server**: @nestjs/graphql with GraphQL Yoga (subscriptions over SSE)
- **Database Client**: node-postgres (Materialize speaks the Postgres wire protocol)
- **SQL**: Kysely, used only to compile a selection to a `SELECT` with bind parameters
- **Streaming**: Repeater (async iterators that clean up as soon as the client goes)
- **Schema**: GraphQL schema generated at startup from `schema.yaml`
- **Configuration**: @nestjs/config with class-validator

## Component Architecture

Three layers, each a Nest module that depends only on the one below.

### Database Module (`src/database/`)

Connections and the database. Nothing above it sees SQL or how the database reports changes.

- **`DatabaseService`** is the layer's one export: `stream(source, selection, mode)`. It compiles the selection to a `SELECT` with bind parameters (`select.ts`), always adding the key to the columns, opens a `DatabaseStream`, and closes any open streams first thing at shutdown.
- **`DatabaseStream`** (`stream.ts`) is one stream: it borrows a connection for its mode on the first read, has the adapter read the stream in that mode, passes on what it reads, and gives the connection back when the stream ends, with the error if it failed. Stopping it cancels the connection at once, even mid-statement.
- **`DatabaseConnectionService`** (`connection.service.ts`) is the one place connections are made: one pool, capped at `DATABASE_MAX_CONNECTIONS`, lending to streams of both modes. A `Live` stream holds its connection until it stops, and it's then discarded, which drops its `SUBSCRIBE`. A `Snapshot` borrows one for one `SELECT`, and gives it back for reuse. Its time limit, `DATABASE_QUERY_TIMEOUT_MS`, is a timed cancel on the same path as a client leaving, since Materialize ignores `statement_timeout` for a `SELECT`. When every connection is taken, a new stream waits for a free one, up to the connect timeout. It stops lending once shutdown starts, and ends the pool last.
- **`DatabaseAdapter`** is the database: one `read(client, source, select, mode)`, over a node-postgres connection. `DatabaseModule` provides `MaterializeAdapter`. Another database that speaks the Postgres protocol, such as RisingWave ([#42](https://github.com/tycoworks/tycostream/issues/42)), would be another adapter, chosen there. One that doesn't would also need its own connection service.
- **`MaterializeAdapter`** (`materialize.ts`) reads a snapshot with `readSnapshot`. It reads a live stream through `DECLARE … CURSOR FOR SUBSCRIBE (…) WITH (SNAPSHOT, PROGRESS)` and a `FETCH` loop, holding each timestamp's rows until a progress row passes it, then pairing them into insert, update and delete events.
  - It uses a cursor because a plain `SUBSCRIBE` never returns through node-postgres, and because bind parameters work in a cursor but not in `COPY (SUBSCRIBE …)`. Materialize doesn't document the second, so an end-to-end test pins it.
  - Its `FETCH` has no timeout, since one with a timeout waits it out even when rows exist.
  - It turns off `idle_in_transaction_session_timeout`, which is 2 minutes by default, since the transaction sits idle while a slow client catches up. Materialize's cap on a subscription's backlog limits a slow client instead.
- **`postgres.ts`** is what every Postgres-compatible database does the same way: a snapshot as one plain `SELECT` (`readSnapshot`), and the value parsers set on the pool (`TYPE_PARSERS`). Values are parsed by the type the database reports, so the layer needs nothing from `schema.yaml`. `int8` and `numeric` become numbers, timestamps become ISO 8601 text, since a JavaScript `Date` would move a timestamp without a time zone into the server's, and `date`, `interval` and `bytea` stay text.

Both modes yield the same thing: tycostream's row events, one complete timestamp at a time, the snapshot first as one batch of inserts.

### View Module (`src/view/`)

The domain layer. `ViewService` is a pass-through to the database layer for now; it's where a shared cache or permissions would go.

### API Module (`src/api/`)

- Generates the GraphQL schema from `schema.yaml`: per source, a type, an update type, a filter input, an `order_by` input, and a query and a subscription that both take `where`, `order_by`, `limit` and `offset`.
- `ApiService` (`api.service.ts`) is the layer's one service. `query` opens a `Snapshot` stream on the view and returns its rows. `subscribe` opens a `Live` stream and turns each timestamp's events into one list of GraphQL updates, each sending only the fields its event names.
- `api.resolver.ts` builds each source's query and subscription resolvers, taking the selection's columns from the request's selection set. A subscription resolver hands GraphQL the service's iterator directly, so a client that disconnects closes its database connection at once; a query resolver passes on the request's signal, which aborts when the client leaves, so the query ends in the database.

### Configuration & Common (`src/config/` and `src/common/`)

- Database and GraphQL settings, validated at startup
- `schema.yaml` loading and validation. An enum column is text in the database, declared as an enum in `schema.yaml`, since Materialize has no enum types. A comparison such as `_gt` on it compiles to an `IN` of the values on that side.
- The types the layers share: `PostgresType`, `Selection`, the `where` and `order_by` operators, `StreamMode`, and row events
- Logging helpers

## Data Flow

1. **A client subscribes** over SSE, with the fields it selects and an optional `where`, `order_by`, `limit`, and `offset`. (A query follows the same path as a `Snapshot` stream, which ends after step 3's snapshot.)
2. **The selection becomes SQL.** It passes through the view layer to `DatabaseService`, which compiles it to `SELECT <columns> … WHERE … ORDER BY … LIMIT … OFFSET …`, with names quoted and values as bind parameters. An unknown field, a comparison with null, a value not in its enum, or a negative limit or offset fails here, before any connection opens.
3. **The client gets its own connection from the pool, and its own `SUBSCRIBE`.** Materialize sends the matching rows as of one timestamp (the snapshot), then every change after it, with a progress row whenever a timestamp is complete.
4. **Each complete timestamp becomes events.** Identical rows are netted, then each key's −1 and +1 are paired: a +1 alone is an insert, a −1 alone a delete, both an update of the columns that differ. A row entering or leaving the client's filter, or its `limit` and `offset` window, arrives as a lone +1 or −1, so it's an insert or a delete.
5. **The client gets each timestamp's events** as one list of GraphQL updates. A slow client holds the next `FETCH` back, so its backlog queues in Materialize, which caps it.
6. **The client disconnects,** and its connection is discarded, which drops the `SUBSCRIBE` in Materialize.

A database error ends that one query or subscription with a GraphQL error, and so does a key that turns out not to be unique in a subscription. The server keeps running.

## Key Design Decisions

### Why one `SUBSCRIBE` per client?

- Materialize already filters, snapshots and orders changes per query; tycostream doesn't have to repeat it.
- No shared cache means no late-joiner races and no copy of every row in tycostream.
- The cost moves to Materialize: a connection and a dataflow per client.

### Why one stream in two modes, over one pool?

- One path connects, cancels, and shuts down both, and a query's rows are a subscription's snapshot by construction.
- A snapshot is a plain `SELECT`, since a `SUBSCRIBE` would build a dataflow for every query.
- One pool, since once the database's budget is spent, a failing query is no worse than a failing subscription. It leaves one number to set, and a live stream can reuse a connection a query has finished with.

### Why raw diffs and progress rows?

- The −1 carries the old row, so updates and deletes need no cache.
- Rows within a timestamp arrive in no useful order, so pairing waits for the whole timestamp. Waiting for progress also means a client never sees half a timestamp.
- The cost: a view whose timestamps stall, such as one with `REFRESH EVERY`, holds its changes back until they move.

### Why `schema.yaml`, not the database's catalog?

- `schema.yaml` is the API's contract: exactly what's served, with keys, columns, and enums. A database that drifts from it gets noticed, not silently followed. Checking it against the database at startup is [#34](https://github.com/tycoworks/tycostream/issues/34).
- Materialize's catalog has no primary keys and no enums, and other databases describe themselves differently.
- Deployment settings are environment variables, kept out of the file.

### Why Postgres types throughout?

- Below the API, a column's type is its Postgres type (`PostgresType` in `common/types.ts`), keyed by the type IDs every Postgres-compatible database reports. It's the only file that imports pg-types, and `schema.yaml` names types as Postgres's catalog does.
- Only the API turns them into GraphQL, in one table (`SCALARS` in `schema.ts`). tycostream's own types had merged several, and `numeric` lost precision as a `Float`.

### Why Hasura v2's conventions?

- Type names (`_bool_exp`, `_comparison_exp`, `_order_by`, `query_root`), scalars, and root fields follow Hasura v2, the nearest thing to a standard for GraphQL over Postgres. A Hasura query runs unchanged, as far as tycostream's features go. v3 lets each project shape its own schema, so there's no v3 standard to follow.
- Subscriptions differ on purpose: they send changes keyed by row. Sending the whole result on every change would be a live query (`@live`), not a subscription.

### Why `Repeater` and not RxJS?

- A `Repeater` cleans up the moment the client goes, even on a quiet view, and its `push` waits for the client, so a slow client's backlog stays in Materialize.
- RxJS can come back for sharing between clients, which is what it's good at.

### Why single process?

- Less to operate; Materialize does the heavy lifting and scales on its own.

## Future Evolution

- **Relationships between sources** ([#2](https://github.com/tycoworks/tycostream/issues/2)): nested GraphQL fields, each pushed down as one `SUBSCRIBE` of a join, so every level stays at one timestamp
- **Sharing between clients** with identical or overlapping filters, model-checked
- **Authentication and row-level security** ([#36](https://github.com/tycoworks/tycostream/issues/36)), in the view layer
- **Observability** ([#37](https://github.com/tycoworks/tycostream/issues/37)): health checks, metrics, and logging
- **Other databases**, such as RisingWave ([#42](https://github.com/tycoworks/tycostream/issues/42))
