# Plan: queries per view

Status: agreed with Chris, 7 Nov 2026. Branch: `queries`. Follows the hollow-out (`hollow-out.md`); `v0.3.0` is released after this branch.

## Summary

Each view gets a GraphQL query beside its subscription: `trades(where: …)` returns the view's current rows that match the filter, once, through a connection pool. It shares the subscription's name, as Hasura's do. The placeholder `ping` query goes.

## Why queries

Hasura already serves queries over Postgres-compatible databases, and a federation gateway (such as Hive, by The Guild) can join it with tycostream's subscriptions behind one endpoint. But offering queries too costs users nothing: at best they need one tool instead of Hasura plus a gateway; at worst they keep their Hasura and use only tycostream's subscriptions (Chris, 7 Nov).

## Requirements

1. **Same rows as a subscription's snapshot.** A query returns the rows a subscription with the same `where` would get as its snapshot, typed the same way.
2. **Same `where`.** The same input type, operators and validation as subscriptions, including the null rule (`hollow-out.md`, D11). No `limit`, `offset` or `order_by` yet; they're on the roadmap.
3. **Queries and subscriptions can't starve each other.** They use separate connections.
4. **Bounded.** A slow query is cut off, and a query waiting for a free connection waits a bounded time.
5. **Cancelled when the client leaves.** A client that disconnects mid-query ends the query in the database.
6. **Clean shutdown.** Stopping tycostream closes every subscription and the pool.

## Research findings

Checked on 7 Nov against `materialize/materialized:v26.49.0`, node-postgres 8 and Nest 12.

- **Materialize ignores `statement_timeout` for `SELECT`.** With a 1 s timeout, set by `SET` or at connect time, a heavy `SELECT` was still running after 20 s; Materialize applies it to writes. So the time limit has to be ours.
- **pg's `query_timeout` works as that limit.** The query fails after the timeout on our side; the pool then discards the connection, and Materialize stopped the query within about 3 s of the connection going. The next query got a fresh connection.
- **The pool needs an `'error'` listener.** Without one, an idle pooled connection that drops (Materialize restarting, say) raises an unhandled `'error'`, and `main.ts` exits the process.
- **pg-pool's `connectionTimeoutMillis` also bounds the wait for a free connection** when the pool is full, not only the time to connect.
- **pg skips `idle_in_transaction_session_timeout: 0` at connect** (0 is falsy), so the Materialize driver keeps turning it off with `SET`.
- **Nest shuts down in this order:** destroy hooks, then the HTTP server closes, then application-shutdown hooks. And without `app.enableShutdownHooks()`, which `main.ts` doesn't call yet, none of them run on SIGTERM.
- **`await using` works** with our TypeScript, SWC and Node, so a borrowed connection can be given back automatically at the end of a scope, even on a throw.

## Design

```
DatabaseModule   (exports DatabaseService only)
  DatabaseService        subscribe(view, where), query(view, where): compiles the SQL,
                         uses the driver, tracks open subscriptions
  DatabaseConnections    acquire(purpose, signal?) → Lease: makes every connection,
                         with each purpose's limits, and closes them in order on shutdown
  DatabaseStream         one subscription: a lease on first read, the driver's read, closed on stop
  DatabaseDriver         subscriptions: SubscriptionProtocol, queries: QueryProtocol
    materialize.ts       MaterializeSubscriptions: DECLARE … SUBSCRIBE, FETCH, progress, pairing
    postgres.ts          PostgresQueries, and typing text values by the schema
```

### Drivers

A driver is a subscription part and a query part, and drivers can share parts:

```ts
abstract class DatabaseDriver {
  abstract readonly subscriptions: SubscriptionProtocol; // read(client, view, query) → events per timestamp
  abstract readonly queries: QueryProtocol;              // run(client, view, query) → rows
}
// Materialize: MaterializeSubscriptions + PostgresQueries
// RisingWave, later: RisingWaveSubscriptions + PostgresQueries
```

- **Querying is the same for every Postgres-compatible database**, so it's written once, in `postgres.ts`. So is typing text values by the schema (`'t'` is true, bigints stay strings, …), which is how they all send text. The Materialize subscriptions use it too, which is what makes requirement 1 hold. A database that queries differently gets its own query part.
- **Subscribing is what differs**, so each database has its own subscription part. Today's `MaterializeProtocolHandler` becomes `MaterializeSubscriptions`, and `ProtocolHandler` becomes `SubscriptionProtocol`.
- **Both parts are stateless:** the view's definition comes with each call, and a subscription's batching state lives inside its `read`.
- **`DatabaseDriver` is an abstract class** so it can be a Nest provider token: `DatabaseModule` provides the Materialize driver, and choosing a database later is that one provider. Tests swap in a fake.

### Connections

`DatabaseConnections` is the one place connections are made. Callers say what a connection is for, and get back the same kind of lease either way:

```ts
enum ConnectionPurpose { Subscription, Query }

interface Lease extends AsyncDisposable {
  readonly client: pg.ClientBase;
  close(): Promise<void>; // finished with it
}

acquire(purpose: ConnectionPurpose, signal?: AbortSignal): Promise<Lease>
```

- **`close()` is finishing normally:** a subscription's connection is ended, which drops its `SUBSCRIBE`; a query's goes back to the pool, unless it hit an error or the timeout, when it's discarded. `await using` calls it at the end of a scope.
- **Aborting the signal is cancelling:** the connection is ended at once, even mid-connect or mid-statement, and never pooled again. A stream aborts when its subscriber stops; a query uses the GraphQL request's signal, so a client that leaves ends its query (checked in step 2; if the signal doesn't fire on disconnect, queries end at the timeout instead).

| | Subscription | Query |
|---|---|---|
| Where from | a new connection each time | a `pg.Pool` |
| How many at once | no limit yet; a cap would go here | `DATABASE_POOL_SIZE` |
| Waiting for a connection | the 10 s connect timeout | the same 10 s bounds the wait for a free pooled connection |
| Time limit per statement | none | `DATABASE_QUERY_TIMEOUT_MS`, enforced by pg on our side |

- **Shared settings,** for every connection: host, credentials, the connect timeout, keep-alive, and reading every value as text, since tycostream types values by `schema.yaml` (D9).
- **Errors:** the pool always has an `'error'` listener, and a lease carries one while it's out, so a dropped connection can't crash the process. A stream adds its own, to end its subscription.
- **Shutdown,** in Nest's order:
  1. Destroy hooks: `DatabaseService` closes the open subscriptions, so SSE responses finish and the HTTP server can close; `DatabaseConnections` stops lending, so a request arriving mid-shutdown fails rather than slipping through.
  2. The HTTP server closes, so no query is in flight.
  3. Application-shutdown hooks: the pool ends, and any subscription connection still open is ended as a safety net.
- **`main.ts` calls `app.enableShutdownHooks()`.**

### Up through the layers

- **Database:** `DatabaseStreamService` becomes `DatabaseService`, with `subscribe` and `query`. Both compile the `where`; `query` borrows a pooled connection and runs the driver's query part. It's the database layer's only export.
- **View:** `ViewService.query(view, where)` beside `subscribe`: a view has current rows you query and changes you subscribe to. Permissions, later, apply to both.
- **API:** the schema gets `Query.<view>(where: <view>Expression): [<view>!]!` per view. The resolvers go in `query.resolver.ts`. A database error is an ordinary GraphQL error for that request.
- **`ping` goes;** the HTTP test uses a real query instead.

### Settings

Environment variables, validated with the rest of the database config. Deployment settings stay out of `schema.yaml`, which is the API contract (Chris, 7 Nov).

| Variable | Default | |
|---|---|---|
| `DATABASE_POOL_SIZE` | 10 | most pooled connections at once |
| `DATABASE_QUERY_TIMEOUT_MS` | 30000 | time limit on a query |

The fetch size, connect timeout and keep-alive stay constants until someone needs to tune them.

## Rejected

- **Two services, each making its own connections:** the connection rules would be split across two places.
- **Two methods, `forSubscription()` and `forQuery()`:** they return different kinds of connection, given back differently, so every caller would have to know which it has.
- **A query part per driver:** querying is the same for every Postgres-compatible database.
- **The pool as a provider under a string token:** as idiomatic, but needs a separate hook to close it; the class that creates it closes it.
- **Materialize's `statement_timeout`:** it doesn't apply to `SELECT`.
- **A new connection per query, no pool:** every query pays to connect (more with TLS to Materialize Cloud), and nothing bounds how many run at once.
- **Answering a query from a subscription's snapshot:** it builds a dataflow per query, where a `SELECT` on an indexed view is a cheap lookup.

## Sequence

One commit each, shown before committing:

1. **Connections and drivers, for subscriptions:** `DatabaseConnections` with the subscription purpose (leases, cancelling, the shutdown order), the shared settings, `DatabaseDriver` with its subscription part, `DatabaseService`, the stream on leases, and the shutdown hook. No change clients can see, apart from a clean shutdown.
2. **Queries:** the query purpose and its settings, `PostgresQueries` and the shared typing in `postgres.ts`, `ViewService.query`, the schema and resolvers; `ping` removed.

## Tests

- **Unit:**
  - `DatabaseConnections`, against a fake pg: each purpose's settings, `close()` against cancelling, refusing to lend once shutdown starts, the pool's `'error'` listener;
  - the stream against a fake `DatabaseConnections`, instead of mocking pg;
  - `PostgresQueries` and its typing; the settings' validation; the schema's query fields; the resolvers.
- **End-to-end:**
  - a filtered query through GraphQL returns the same typed rows as a subscription's snapshot;
  - a query over the time limit fails, and Materialize stops it;
  - a client disconnecting mid-query ends the query;
  - a database error is a GraphQL error, and the server keeps serving;
  - shutting down closes the subscriptions and the pool.
