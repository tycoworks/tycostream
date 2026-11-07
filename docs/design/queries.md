# Plan: queries per view

Status: proposed, 7 Nov 2026. Follows the hollow-out (`hollow-out.md`), which ended at its step 4.

## Summary

Each view gets a GraphQL query beside its subscription: `trades(where: …)` returns the view's current rows that match the filter, once, through a connection pool. It shares the subscription's name, as Hasura's do. The placeholder `ping` query goes.

## Requirements

1. **Same rows as a subscription's snapshot.** A query returns the rows a subscription with the same `where` would get as its snapshot, typed the same way.
2. **Same `where`.** The same input type, operators and validation as subscriptions, including the null rule (`hollow-out.md`, D11).
3. **Queries can't starve subscriptions, or the reverse.** They use separate connections.
4. **Bounded.** A slow query is cut off, and a burst of queries waits for a free connection for a bounded time, not forever.
5. **Clean shutdown.** Stopping tycostream closes the pool and every open subscription.

## Design

### Two connection policies

Both live in `DatabaseModule`, side by side:

| | Subscriptions (exists) | Queries (new) |
|---|---|---|
| Service | `DatabaseStreamService` | `DatabaseQueryService` |
| Connections | one dedicated `pg.Client` each, opened on first read | a shared `pg.Pool` |
| Lifetime | until the client leaves | one statement |
| Time limit | none; idle-in-transaction timeout turned off | `statement_timeout`, so a heavy query can't hold a pooled connection |
| Capacity limit | Materialize's 128 MiB backlog cap per subscription | pool size, and a bounded wait for a free connection |

The settings both share (host, credentials, connect timeout, keep-alive) move out of `stream.ts` into one function that both use.

### Nest wiring

- **The pool is a custom provider:** a `DATABASE_POOL` token whose `useFactory` builds a `pg.Pool` from `ConfigService`. One instance, injectable, and replaceable in tests.
- **`DatabaseModule` ends the pool** in `onApplicationShutdown`. `DatabaseQueryService` only injects it.
- **`main.ts` calls `app.enableShutdownHooks()`.** It doesn't today, so on SIGTERM Nest's shutdown hooks never run and open subscriptions aren't closed cleanly either.

### The driver

- `ProtocolHandler` gets `query(client, query)` beside `read`, so the driver still says everything that's said over a connection.
- Materialize's runs the same `SELECT … WHERE` that a subscription wraps, with every column as text, and types the rows with the function subscriptions use. That function moves out of `ProgressBatcher` so both share it, which is what makes requirement 1 hold.

### Up through the layers

- **View:** `ViewService.query(view, where)`, a pass-through like `subscribe`, so later permissions apply to both.
- **API:** the schema gets `Query.<view>(where: <view>Expression): [<view>!]!` per view. The resolvers go in `query.resolver.ts` and call `ViewService.query`. A database error is an ordinary GraphQL error for that request.
- **`ping` goes;** the HTTP test uses a real query instead.

### Settings

Validated with the rest of the database config:

| Variable | Default | |
|---|---|---|
| `DATABASE_POOL_SIZE` | 10 (pg's default) | most pooled connections at once |
| `DATABASE_QUERY_TIMEOUT_MS` | 30000 | `statement_timeout` for queries |

## Sequence

One commit each, shown before committing:

1. **Groundwork:** `app.enableShutdownHooks()`, and the shared connection settings. No behaviour change beyond a clean shutdown.
2. **Queries:** the settings, the pool provider, `DatabaseQueryService`, the driver's `query`, `ViewService.query`, the schema and resolvers; `ping` removed.

## Tests

- **Unit:** the driver's `query` and its typing; `DatabaseQueryService` against a fake pool; the settings' validation; the schema's query fields; the resolvers.
- **End-to-end:** a filtered query through GraphQL returns the same typed rows as a subscription's snapshot; a database error is a GraphQL error and the server keeps serving; shutting down closes the pool (no sessions left in `mz_internal.mz_sessions`).
