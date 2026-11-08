# Plan: queries, as snapshot streams

Status: agreed with Chris, 7 Nov 2026; redesigned around streams the same day. Branch: `queries`. Follows the hollow-out (`hollow-out.md`); `v0.3.0` is released after this branch.

## Summary

Each source gets a GraphQL query beside its subscription: `trades(where: …)` returns the source's current rows that match the filter, once. It shares the subscription's name, as Hasura's do. The placeholder `ping` query goes.

Internally there's one concept, a **stream** on a source, opened in one of two modes, as in T-Bricks:

- **`Live`:** the snapshot, then every change. A GraphQL subscription.
- **`Snapshot`:** the snapshot, then the stream ends. A GraphQL query.

## Why queries

Hasura already serves queries over Postgres-compatible databases, and a federation gateway (such as Hive, by The Guild) can join it with tycostream's subscriptions behind one endpoint. But offering queries too costs users nothing: at best they need one tool instead of Hasura plus a gateway; at worst they keep their Hasura and use only tycostream's subscriptions (Chris, 7 Nov).

## Why one concept

A query is a subscription that stops after its snapshot (Chris, 7 Nov). Treating them as one, a stream with a mode, means:

- **one path below the API:** the same stream, connections, cancelling and shutdown for both;
- **the same rows by construction:** a query's result and a subscription's snapshot are the same thing, typed by the same code;
- **post 4's shared cache serves both** the same way: a snapshot is the cache's current rows; live is those rows, then the changes.

The API still presents them as GraphQL queries and subscriptions.

## Requirements

1. **Same rows as a subscription's snapshot.** A query returns the rows a subscription with the same `where` gets as its snapshot, typed the same way.
2. **Same `where`.** The same input type, operators and validation, including the null rule (`hollow-out.md`, D11). No `limit`, `offset` or `order_by` yet; they're on the roadmap.
3. **Bounded, and protecting the database.** At most `DATABASE_MAX_CONNECTIONS` streams of either mode hold connections at once. When they're all taken, a new stream waits a bounded time, then fails, whatever its mode (Chris, 7 Nov). A snapshot over `DATABASE_QUERY_TIMEOUT_MS`, waiting included, is cut off.
4. **Cancelled when the client leaves,** for both modes: the stream ends in the database.
5. **Failures stay local.** A database error ends that one stream with a GraphQL error.
6. **Clean shutdown.** Stopping tycostream closes every stream, then the pool.

## Research findings

Checked on 7 Nov against `materialize/materialized:v26.49.0`, node-postgres 8 and Nest 12.

- **Materialize ignores `statement_timeout` for `SELECT`.** With a 1 s timeout, set by `SET` or at connect time, a heavy `SELECT` was still running after 20 s; Materialize applies it to writes. So the time limit has to be ours.
- **pg's `query_timeout` works as that limit.** The query fails after the timeout on our side; the pool then discards the connection, and Materialize stopped the query within about 3 s of the connection going. The next query got a fresh connection.
- **A pool's size is a ceiling.** pg-pool opens connections as they're needed, up to `max`; a connection given back is either kept for the next borrower (reused) or closed and forgotten (discarded), and the next borrower then gets a new one. Its `min` only stops it closing idle connections below that number; it never opens them ahead of time.
- **A connection a snapshot has finished with is clean,** so any stream can reuse it, a live one included. **A live stream's connection isn't worth reusing.** Its `SUBSCRIBE` lives in an open transaction; reusing it means cancelling the `FETCH` in flight (pg sends a cancel request over a second connection), rolling back, and only then giving it back. That saves one connect per subscription, which lasts minutes or hours and already waits longer for Materialize to build its dataflow.
- **A pool needs an `'error'` listener.** Without one, an idle pooled connection that drops (Materialize restarting, say) raises an unhandled `'error'`, and `main.ts` exits the process.
- **pg-pool's `connectionTimeoutMillis` also bounds the wait for a free connection** when the pool is full, and ends a connection that's stuck connecting.
- **pg's `connect()` never settles if its connection is ended in its first millisecond or so.** A stream cancelled that early must stop waiting rather than wait for it.
- **pg skips `idle_in_transaction_session_timeout: 0` at connect** (0 is falsy), so the Materialize protocol keeps turning it off with `SET`.
- **Nest shuts down in this order:** destroy hooks, then the HTTP server closes, then application-shutdown hooks. Without `app.enableShutdownHooks()` none of them run on SIGTERM.
- **`await using` works** with our TypeScript, SWC and Node.

## Design

```
DatabaseModule   (exports DatabaseService only)
  DatabaseService            stream(source, where, mode) → RowUpdateBatches: compiles the
                             SELECT, opens a DatabaseStream, closes open streams at shutdown
  DatabaseStream             one stream: borrows a connection for its mode on first read,
                             has the adapter read it in its mode, gives it back on stop
  DatabaseConnectionService  acquire(mode, signal?) → ConnectionLease: one pool, a policy per mode
  DatabaseAdapter            read(client, source, select, mode): the database
    materialize.ts           MaterializeAdapter: snapshots by readSnapshot; live by
                             DECLARE … SUBSCRIBE, FETCH, progress, pairing
    postgres.ts              what Postgres-compatible databases do alike: values as text,
                             typing them by the schema, readSnapshot (one SELECT)
  select.ts                  buildSelect(source, where) → CompiledSelect
```

### Streams

```ts
enum StreamMode { Snapshot, Live }   // Live: the snapshot, then every change

DatabaseService.stream(source, where, mode): RowUpdateBatches
```

- Both modes yield the snapshot first, as one batch of insert events. `Snapshot` then ends; `Live` goes on with a batch per timestamp.
- **`DatabaseStream` serves both:** borrow a connection for the mode on the first read, have the adapter read the stream in its mode, pass on its batches, and give the connection back when it ends, or with the error if it failed, so a pooled connection that failed is discarded. Stopping cancels the connection, even mid-statement or while it's connecting.
- **`DatabaseService.stream`** compiles the `where` (throwing on an invalid filter, before any connection), opens a `DatabaseStream`, and tracks it until it closes. It's the database layer's only export.

### Adapters

An adapter is the database: one class, with one method that reads a stream in either mode. "Adapter", not "driver": node-postgres is the driver (Chris, 8 Nov).

```ts
abstract class DatabaseAdapter {           // abstract, so it can be a Nest provider token
  abstract read(client, source, select, mode): AsyncIterable<RowUpdateEvent[]>; // the snapshot first
}

class MaterializeAdapter extends DatabaseAdapter {
  read(client, source, select, mode) {
    return mode === StreamMode.Snapshot
      ? readSnapshot(client, source, select)   // postgres.ts, shared
      : this.readLive(client, source, select); // SUBSCRIBE, FETCH, progress, pairing
  }
}
// RisingWave, later: a RisingWaveAdapter, with readSnapshot for snapshots and its own live read
```

- **Only live reading differs between databases,** so it's each adapter's own code. Today's `MaterializeSubscriptionProtocol` becomes `MaterializeAdapter`.
- **A snapshot is the same for every Postgres-compatible database:** one `SELECT`, its rows typed and yielded as one batch of inserts. `readSnapshot`, a function in `postgres.ts`, serves every adapter that wants it (Chris's idea of sharing the query part, kept as a function).
- **An adapter is stateless:** the source comes with each call, and a live stream's batching state lives inside its read.
- **`postgres.ts` holds everything Postgres-compatible databases do alike:** values sent as text (every connection asks for text), `parseRow` typing a row by the schema (`'t'` is true, bigints stay strings, …), `insertOf`, and `readSnapshot`. One file rather than two (Chris, 8 Nov).
- **`DatabaseModule` provides `MaterializeAdapter` as the `DatabaseAdapter`;** choosing another database later is that one provider. Tests swap in a fake.

### Connections

`DatabaseConnectionService` is the one place connections are made: one `pg.Pool`, capped at `DATABASE_MAX_CONNECTIONS`, lending to both modes, with one borrowing path. What differs per mode is a small policy:

| | `Live` (subscriptions) | `Snapshot` (queries) |
|---|---|---|
| Given back | always discarded: ending the connection drops its `SUBSCRIBE` at once | back to the pool for reuse, unless it failed or was cancelled |
| Time limit | none | `DATABASE_QUERY_TIMEOUT_MS`, waiting included |

```ts
interface ConnectionLease extends AsyncDisposable {
  readonly client: pg.ClientBase;
  readonly signal: AbortSignal;          // aborted when the lease is cancelled, and why
  close(error?: unknown): Promise<void>; // given back; with the error if the work failed
}

acquire(mode: StreamMode, signal?: AbortSignal): Promise<ConnectionLease>
```

- **Cancelling, by the caller or by the time limit, is one path:** the connection is discarded at once, even mid-statement, and Materialize stops what it was running. If the connection is still being made, acquire stops waiting, and gives back the one the pool hands over later. The time limit is a timed cancel (`AbortSignal.timeout`), so a query over it fails with a timeout error; the lease's `signal` says which it was, so the stream can report it.
- **Waiting for a free connection** is bounded by the 10 s connect timeout, for both modes.
- **Shared settings,** for every connection: host, credentials, the connect timeout, keep-alive, and reading values as text (`postgres.ts`).
- **Errors:** the pool always has an `'error'` listener, and a lease carries one while it's out, so a dropped connection can't crash the process. A stream adds its own, to end itself.
- **Shutdown,** in Nest's order:
  1. Destroy hooks: `DatabaseService` closes the open streams, so SSE responses finish and the HTTP server can close; `DatabaseConnectionService` stops lending, so a request arriving mid-shutdown fails rather than slipping through.
  2. The HTTP server closes.
  3. Application-shutdown hooks: the pool ends.

### Up through the layers

- **View:** `ViewService.stream(source, where, mode)`, a pass-through. A view, a source plus a `where`, can be streamed either way; permissions, later, apply to both.
- **API:** one service and one resolver file for both GraphQL operations, since they differ only in mode and in how the result is shaped (Chris, 7 Nov). Each layer is a module with one main service named after it: `DatabaseModule` and `DatabaseService`, `ViewModule` and `ViewService`, `ApiModule` and `ApiService`.
  - `ApiService` (`api.service.ts`, replacing `SubscriptionService`): `subscribe(source, where)` opens a `Live` stream and sends each event as a GraphQL update, as today; `query(source, where)` opens a `Snapshot` stream and returns its events' rows. When the GraphQL request is aborted, the query stops reading, which cancels its stream.
  - `api.resolver.ts` (replacing `subscription.resolver.ts`) builds both the `Query` and `Subscription` resolvers per source. The schema gets `Query.<source>(where: <source>Expression): [<source>!]!` beside each subscription.
  - These are the only places the words "query" and "subscription" name operations; below the API, it's a stream and its mode.
- **`ping` goes;** the HTTP test uses a real query instead.

### Names

| Was | Now |
|---|---|
| `SubscriptionProtocol`, and `DatabaseAdapter.subscriptions` | `DatabaseAdapter.read(client, source, select, mode)` |
| `MaterializeSubscriptionProtocol` | `MaterializeAdapter` |
| `DatabaseDriver` (commit 2) | `DatabaseAdapter` |
| `ConnectionType` | `StreamMode`, used for connections too |
| `DatabaseService.subscribe` | `DatabaseService.stream` |
| `ViewService.subscribe` | `ViewService.stream` |
| `query.ts`: `buildSelect` → `CompiledQuery` | `select.ts`: `buildSelect` → `CompiledSelect`; "query" now means a GraphQL query |
| `Record<string, any>` for a row | `Row`, in `common/types.ts`, which `RowUpdateEvent.row` uses |
| `SubscriptionService` (`subscription.service.ts`) | `ApiService` (`api.service.ts`), with `subscribe` and `query` |
| `subscription.resolver.ts` | `api.resolver.ts`, building both `Query` and `Subscription` resolvers |

### Settings

Environment variables, validated with the rest of the database config, and named for what users see. Deployment settings stay out of `schema.yaml`, which is the API contract (Chris, 7 Nov).

| Variable | Default | |
|---|---|---|
| `DATABASE_MAX_CONNECTIONS` | 1000 | most connections at once: each subscription holds one, each query borrows one; the number to set against the database's own limit |
| `DATABASE_QUERY_TIMEOUT_MS` | 30000 | time limit on a query, waiting for a connection included |

Both defaults are starting points, not measurements. The fetch size, connect timeout and keep-alive stay constants until someone needs to tune them.

## Rejected

- **Queries and subscriptions as separate mechanisms** (this plan's first version): two paths to keep in step, and a query's rows and a snapshot only equal by test, not by construction.
- **A snapshot by `SUBSCRIBE`, taking its first batch:** it builds a dataflow per query, where a `SELECT` on an indexed view is a cheap lookup.
- **A protocol per mode on each driver, as it was then called** (`StreamProtocol`, `PostgresSnapshotProtocol`, `MaterializeLiveProtocol`, this plan's second version): many names for little, since only live reading differs between databases; a shared function covers snapshots.
- **Reusing live connections:** see the research findings.
- **A pool per mode, so neither can take the other's connections:** when the database's budget is used up, a query failing is no worse than a subscription failing (Chris, 7 Nov). One pool means one number to set, lets a live stream reuse a connection a query has finished with, and turns the query time limit into a timed cancel instead of a second mechanism.
- **A new connection per query, no pool:** every query pays to connect, and nothing bounds how many run at once.
- **Separate methods per kind of connection** (`forSubscription()`, `forQuery()`): different kinds of connection, given back differently, so every caller would have to know which it has.
- **A pool as a provider under a string token:** as idiomatic, but needs a separate hook to close it; the class that creates it closes it.
- **Materialize's `statement_timeout`:** it doesn't apply to `SELECT`.

## Sequence

One commit each, shown before committing. Each builds and passes every test on its own, and each reviewed piece is its own commit (Chris, 7 Nov).

1. **`DatabaseConnectionService`:** leases and cancelling, the shared settings, the shutdown order and `app.enableShutdownHooks()`; the stream borrows its connection. (Done.)
2. **Drivers:** `DatabaseDriver` (now `DatabaseAdapter`), `DatabaseService`, and the renames that went with them. (Done.)
3. **Names and the text format:** `Row`; `query.ts` becomes `select.ts`; `rows.ts`, merged into `postgres.ts` in step 5. No change in behaviour. (Done.)
4. **One pool, and `StreamMode`:** the capped pool with the policy per mode and the time limit; the two settings; subscriptions borrow live connections from it. (Done.)
5. **Snapshot streams:** `DatabaseAdapter.read` with its mode, `MaterializeAdapter`, and `readSnapshot`, with `rows.ts` merged into `postgres.ts`; `DatabaseStream` in both modes; `DatabaseService.stream`; the snapshot tests against Materialize. Nothing new reaches GraphQL yet. (Done.)
6. **The connection cap, tested against Materialize, and the docs.** (Done.)
7. **Queries through GraphQL,** in two commits:
   - **7a, names:** `ViewService.stream`; `ApiService` and `api.resolver.ts`, replacing `SubscriptionService` and `subscription.resolver.ts`. (Done.)
   - **7b, queries:** a query field per source; `ApiService.query`; `Query` resolvers that pass on the request's signal, so a client leaving ends its query; `ping` removed; `DATABASE_QUERY_TIMEOUT_MS` in the README; the end-to-end tests.

## Tests

- **Unit:**
  - `DatabaseConnectionService`, against a fake pg: the pool's settings, each mode's policy (giving back against discarding, the time limit), cancelling while waiting and while lent, refusing to lend once shutdown starts, the pool's `'error'` listener, ending the pool;
  - `DatabaseStream` in both modes, against a fake connection service; `DatabaseService.stream`;
  - `MaterializeAdapter` in both modes, `readSnapshot`, and `parseRow`; the settings' validation;
  - the schema's query fields, `ApiService` and the resolvers.
- **Against Materialize:**
  - a snapshot returns the same typed rows as a live stream's snapshot;
  - a snapshot over the time limit fails, and Materialize stops it; a cancelled one ends, and Materialize stops it;
  - a stream beyond `DATABASE_MAX_CONNECTIONS` waits, then fails, in either mode;
  - everything the live tests check today.
- **End-to-end, through GraphQL:** a filtered query returns the same rows as a subscription's snapshot; a database error is a GraphQL error and the server keeps serving; a client leaving mid-query ends it.
