# Architecture

## Overview

tycostream turns database views into GraphQL queries and subscriptions. Each source in `schema.yaml` gets a query of its current rows and a subscription to them and every change; each client's subscription is pushed down to Materialize as its own `SUBSCRIBE` of a filtered `SELECT`, and each query as a plain `SELECT`, so Materialize does the filtering and the snapshot, and tycostream holds no rows beyond the changes it's passing on.

**Sources, views and streams.** A *source* is whatever tycostream reads from: a table or view in the database, as listed in `schema.yaml`. (Not a Materialize `SOURCE`, which brings data into Materialize.) A *view* is one client's filtered window onto a source: a source plus a `where`. A *stream* is one running read of a view, in a mode: `Snapshot` (the current rows, then it ends) or `Live` (the current rows, then every change). Only the API speaks of queries and subscriptions; below it, a GraphQL query is a `Snapshot` stream and a subscription a `Live` one.

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

Connections and the database. Nothing above it sees SQL or how the database reports changes.

- **`DatabaseService`** is the layer's one export: `stream(source, selection, mode)`. It builds the client's selection into a `Statement` (`statement.ts`, with `filter.ts` for its `where`), a `SELECT` with bind parameters, opens a `DatabaseStream` of it, and closes any open streams first thing at shutdown.
- **`DatabaseStream`** (`stream.ts`) is one stream: it borrows a connection for its mode on the first read, has the adapter read the stream in that mode, passes on what it reads, and gives the connection back when the stream ends, with the error if it failed. Stopping it cancels the connection at once, even mid-statement.
- **`DatabaseConnectionService`** (`connection.service.ts`) is the one place connections are made: one pool, capped at `DATABASE_MAX_CONNECTIONS`, lending to streams of both modes. A `Live` stream holds its connection until it stops, and it's then discarded, which drops its `SUBSCRIBE`; a `Snapshot` borrows one for one `SELECT`, gives it back for reuse, and is cut off after `DATABASE_QUERY_TIMEOUT_MS`, waiting included. When every connection is taken, a new stream waits for a free one, up to the connect timeout. It stops lending once shutdown starts, and ends the pool last.
- **`DatabaseAdapter`** is the database: one `read(client, statement)`, in the statement's mode. `DatabaseModule` provides `MaterializeAdapter`; another database would be another adapter, chosen there.
- **`MaterializeAdapter`** (`materialize.ts`) reads a snapshot with `readSnapshot`, and a live stream through `DECLARE … CURSOR FOR SUBSCRIBE (…) WITH (SNAPSHOT, PROGRESS)` and a `FETCH` loop, holding each timestamp's rows until a progress row passes it, then pairing them into insert, update and delete events.
- **`postgres.ts`** is what every Postgres-compatible database does the same way: values sent as text, typed by the schema (`parseRow`), and a snapshot as one plain `SELECT` (`readSnapshot`).

Both modes yield the same thing: tycostream's row events, one complete timestamp at a time, the snapshot first as one batch of inserts.

### View Module (`src/view/`)

The domain layer. `ViewService` is a pass-through to the database layer for now; it's where a shared cache, filtering in memory, or permissions would go.

### API Module (`src/api/`)

- Generates the GraphQL schema from `schema.yaml`: per source, a type, an update type, a filter input, a query returning its rows, and a subscription returning its updates.
- `ApiService` (`api.service.ts`) is the layer's one service. `query` opens a `Snapshot` stream on the view and returns its rows. `subscribe` opens a `Live` stream and turns each event into a GraphQL update, sending only the fields the event names.
- `tree.ts` builds the responses from the events: a query's rows (`toRows`), and a subscription's updates (`toUpdates`).
- `api.resolver.ts` builds each source's query and subscription resolvers. A subscription resolver hands GraphQL the service's iterator directly, so a client that disconnects closes its database connection at once; a query resolver passes on the request's signal, which aborts when the client leaves, so the query ends in the database.

### Configuration & Common (`src/config/` and `src/common/`)

- Database and GraphQL settings, validated at startup
- `schema.yaml` loading and validation
- The `where` operators and row events the layers share
- Logging helpers

## Data Flow

1. **A client subscribes** over SSE, with an optional `where`. (A query follows the same path as a `Snapshot` stream, which ends after step 3's snapshot.)
2. **The filter becomes SQL.** The `where` passes through the view layer to `DatabaseService`, which compiles it to `SELECT … WHERE …` with its values as bind parameters. An invalid filter fails here, before any connection opens.
3. **The client gets its own connection from the pool, and its own `SUBSCRIBE`.** Materialize sends the matching rows as of one timestamp (the snapshot), then every change after it, with a progress row whenever a timestamp is complete.
4. **Each complete timestamp becomes events.** Identical rows are netted, then each key's −1 and +1 are paired: a +1 alone is an insert, a −1 alone a delete, both an update of the columns that differ. A row entering or leaving the client's filter arrives as a lone +1 or −1, so it's an insert or a delete.
5. **The client gets each event** as a GraphQL update. A slow client holds the next `FETCH` back, so its backlog queues in Materialize, which caps it.
6. **The client disconnects,** and its connection is discarded, which drops the `SUBSCRIBE` in Materialize.

A database error, or a source whose key turns out not to be unique, ends that one query or subscription with a GraphQL error. The server keeps running.

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

- **Queries per source,** as `Snapshot` streams, through GraphQL: [design/queries.md](./design/queries.md)
- **Relationships between sources:** nested GraphQL fields, each pushed down as one `SUBSCRIBE` of a join, so every level stays at one timestamp
- **Sharing between clients** with identical or overlapping filters, model-checked
- **Permissions** in the view layer
- **Monitoring**: OpenTelemetry instrumentation points
