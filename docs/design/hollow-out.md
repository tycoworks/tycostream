# Plan: hollow out tycostream

Status: agreed with Chris, 6 Nov 2026. Branch: `hollow-out`. Work not started.

## Summary

Today tycostream opens one shared `SUBSCRIBE` per view, keeps every row in an in-memory cache, and filters each client's `where` in JavaScript. The hollow-out pushes each client's filter down into Materialize instead: every GraphQL subscription gets its own `SUBSCRIBE (SELECT … WHERE …) WITH (SNAPSHOT, PROGRESS)`, and tycostream holds no rows beyond the current timestamp's changes. Clients see no change: the same schema, the same `where` filters, and the same update events.

It's the code behind post 2 ("Can a view server be built with GraphQL?"). The shared cache comes back, model-checked, in post 4.

## Requirements

What must hold when the branch merges:

1. **Same API.** The generated schema, the `where` operators, and the update events (`operation`, `data`, `fields`) are unchanged. An `INSERT` carries every column, an `UPDATE` the key plus the changed columns, a `DELETE` the key only.
2. **Snapshot, then changes.** A new subscription gets the current rows, then every change after them, with nothing missed or repeated. This includes clients that join while another client's snapshot is loading (the late-joiner bug below).
3. **Whole timestamps.** All the changes at one Materialize timestamp reach the client together, never half a timestamp.
4. **Keyed views only.** Each view declares a key. If Materialize sends something the key can't explain (two rows for one key), that subscription ends with an error.
5. **Failures stay local.** A database error ends the affected subscription with a GraphQL error. The server keeps running. Today any database error shuts tycostream down.
6. **Generally available Materialize features only.** Nothing in private preview: no `ENVELOPE DEBEZIUM`, no `WITHIN TIMESTAMP ORDER BY`, no history retention or `AS OF` resume.
7. **Each step leaves tycostream building, its tests passing, and the app running against Materialize.**

## Not in scope

- A shared cache, or any sharing between identical subscriptions (post 4).
- Permissions, and the fan-out measurement (post 4, "if at all").
- Resuming a subscription after a reconnect. A reconnecting client gets a fresh snapshot.
- WebSockets. Subscriptions stay on SSE.
- Discovering views and columns from Materialize's catalog (D9).

## Research findings

Three research passes on 6 Nov, with claims marked "verified" run against `materialize/materialized:v26.49.1`.

### Reading `SUBSCRIBE` from Node

- **Materialize recommends `DECLARE c CURSOR FOR SUBSCRIBE …` and `FETCH`, inside a transaction.** Its docs warn that a driver's normal query call on a plain `SUBSCRIBE` "may never return" (verified: `client.query('SUBSCRIBE …')` never resolves). `COPY (SUBSCRIBE …) TO STDOUT`, which tycostream uses today, is documented for interactive tools like `psql`.
- **Bind parameters work in `DECLARE … CURSOR FOR SUBSCRIBE (… WHERE x = $1)`** (verified, but not documented), and fail in `COPY (SUBSCRIBE …)`. So filter values can be parameters, not escaped literals.
- **`FETCH` without a timeout returns as soon as rows exist.** With `WITH (timeout = …)` it waits out the whole timeout (verified), so we don't use a timeout. With `PROGRESS`, an idle subscription still gets a progress row about once a second on the emulator, so `FETCH` never waits long.
- **One `SUBSCRIBE` per transaction, and a cursor can't outlive its transaction.** So each subscription needs its own connection. The emulator allows 5,000 connections.
- **Cleanup:** `ROLLBACK` (or ending the connection) drops the dataflow at once. `CLOSE` alone leaves it running (verified through `mz_internal.mz_subscriptions`).
- **Slow consumers:** if tycostream stops fetching, rows queue inside Materialize, up to 128 MiB per subscription (`subscribe_max_buffered_bytes`, since v26.39). Past that, Materialize ends the subscribe with error 53200. So backpressure is safe: pausing `FETCH` can't run Materialize out of memory, and a hopelessly slow client gets an error.
- **Ordering:** rows within a timestamp come in no useful order (retractions don't come first), so buffering each timestamp until progress passes it, then pairing, is right.
- **`idle_in_transaction_session_timeout` is 2 minutes,** so the `FETCH` loop must never sit idle between fetches that long. With progress rows every second, it doesn't.
- **The old antennas demo** (2022) used the same `DECLARE`/`FETCH` approach, wrapped in Node streams with a hand-rolled backpressure counter. That counter is buggy and never engages. Its idea is superseded: Materialize's own SDK design (Nov 2026) fetches continuously into a bounded buffer and fails fast when the consumer falls behind. That's the design below.

### NestJS data access and SQL

- **No official raw-Postgres module in Nest.** The idiomatic route is a small module of our own: a `pg.Pool` as a custom provider built from `ConfigService`, closed in `onModuleDestroy`, with `app.enableShutdownHooks()`.
- **Subscriptions shouldn't come from the pool.** A long-lived checkout counts against the pool's size and would starve queries, and the connection can't be reused afterwards anyway. One `pg.Client` per subscription, a pool only for plain queries.
- **SQL building: Kysely 0.29, used compile-only.** It quotes identifiers, emits `$n` parameters, compiles to `{ sql, parameters }` without running anything, is ES-module native with no dependencies, and is what MikroORM 7 moved to. Knex is CommonJS with 14 dependencies. Drizzle's compile step is semi-internal. ORMs need entities defined in code, which we don't have.
- **No maintained library compiles Hasura's `where` format to SQL.** We keep our own parser and validator and replace only its output, about 40 lines on Kysely's expression builder. Gotchas: an empty `_in` must become `false`, not `in ()`.
- **Subscriptions without RxJS: a `Repeater`** (re-exported by graphql-yoga). Its `stop` promise resolves the moment the client disconnects, so the connection closes at once. An async generator stuck in an `await` took 2 s to notice (measured). `push` awaits the consumer, which gives backpressure for free.
- **The runtime-built schema in `forRootAsync` is fine.** Nest's code-first tools assume classes known at build time.

### Discovering views from Materialize

- **Materialize's MCP server decides what to expose with plain catalog rules:** a materialized view, or a view with an index on a cluster the role can use, that the role has `SELECT` on, outside system schemas. Tables aren't exposed.
- **We can apply the same rules ourselves at startup** through the stable `mz_catalog` relations (`mz_objects`, `mz_columns`, `mz_indexes`, `mz_index_columns`, …), which give exact column types and nullability. The MCP server's own views (`mz_internal.mz_mcp_data_products`) are in `mz_internal`, which Materialize says isn't stable, so we copy the rules rather than read those views.
- **The catalog gives no primary key and no enums.** Index columns are lookup keys, not unique keys, and Materialize has no enum types. So keys and enums stay declared by us.
- **Status:** the MCP server is public preview in v26.49 and marked GA from v26.50. The `mz_catalog` relations we'd use are stable either way.
- **Worth copying:** serve only indexed or materialized views, because a plain view is recomputed from scratch for every subscription.
- **Not adopted (Chris, 6 Nov):** see D9. A later idea: check `schema.yaml` against the catalog at startup and fail on a mismatch, so the file stays the contract but drift is caught.

## Decisions

| | Decision | Why |
|---|---|---|
| D1 | Read each subscription with `BEGIN; DECLARE c CURSOR FOR SUBSCRIBE (…) WITH (SNAPSHOT, PROGRESS)`, then loop `FETCH 1000 c` with no timeout | Materialize's recommended way; parameters work; returns as soon as rows exist |
| D2 | node-postgres `pg.Client`, one per subscription; a `pg.Pool` only for plain queries, as a Nest async provider in `DatabaseModule` | Subscriptions hold their connection for life; a custom provider is Nest's documented way to wire a raw driver |
| D3 | Filter values as bind parameters, pinned by an end-to-end test; `escapeLiteral` as the fallback if a Materialize release drops them | Verified but undocumented |
| D4 | Kysely, compile-only, for the `SELECT … WHERE`; our own `where` walker on top | Safe quoting and parameters without an ORM |
| D5 | A `Repeater` per subscription, ending with `ROLLBACK` and `client.end()` in its cleanup, in place of today's RxJS `Observable` plus `eachValueFrom` (rxjs-for-await) | `eachValueFrom` only unsubscribes once the next value arrives, so on a quiet view a disconnected client would hold its connection and dataflow open; it also queues values without limit. A `Repeater` cleans up at once and its `push` waits for the client, so a slow client's backlog stays in Materialize, which caps it. RxJS can come back for post 4's sharing, which is what it's good at, with a `Repeater` still at the GraphQL edge |
| D6 | Change processing is a pure module: buffer a timestamp, net identical rows, pair `−1`/`+1` per key | No I/O, so it unit-tests well, and it's what post 4's model describes |
| D7 | Drop `pg-copy-streams`, the COPY text parser, `rxjs-for-await` and our own RxJS use | `DECLARE`/`FETCH` returns typed rows; Nest still depends on RxJS itself |
| D8 | Database errors end the one subscription with a GraphQL error | Requirement 5 |
| D9 | Keep `schema.yaml` as tycostream's contract: the views it serves, their keys, columns and enums. No discovery from the catalog (Chris, 6 Nov) | It says exactly what's exposed over GraphQL; a gateway expecting one schema should notice when the database differs, not silently follow it; and other streaming databases expose metadata differently |

## The change rules

Applied to each complete timestamp, once a progress row passes it:

1. **Net out identical rows.** Sum the `mz_diff` of identical rows and drop any that come to zero. `mz_diff` is a count, not a flag.
2. **Then per key:**
   - a `−1` alone is a `DELETE`, and a `+1` alone is an `INSERT`;
   - a `−1` and a `+1` together are an `UPDATE`, whose `fields` are the columns that differ between the two rows;
   - anything else (a diff above 1, or two `+1` rows) means the key isn't unique: end the subscription with an error.
3. **Rows entering or leaving a client's `where`** arrive as a lone `+1` or `−1`, so they become inserts and deletes with no extra logic.
4. **The snapshot** is the first timestamp, all `+1`, so it's a batch of inserts.

### Why raw diffs, not `ENVELOPE UPSERT`

- With one `SUBSCRIBE` per client, the upsert envelope sends only each key's new row. tycostream would then have to hold every row each client has, to tell inserts from updates and to find the changed fields: one copy of the data per client, more than the old shared cache held.
- Raw diffs carry the old row in the `−1`, so tycostream only ever holds the current timestamp's changes.
- Both rows matter. Deletes, and rows leaving a filter, show only as a `−1`. The `−1` carries the old values. Without a key, the `−1` is the only way to say which copy went. And because order within a timestamp isn't fixed, applying rows as they arrive could let an old row's `−1` delete the row that replaced it; buffering to progress fixes that.
- `ENVELOPE DEBEZIUM` would pair the rows for us, but it's private preview.

### Bugs in today's code that this fixes

Found by reading the code on 5 Nov; only the first gets its own test (step 1).

- **Late joiners can miss part of a timestamp** (`src/view/source.ts`). A new client's snapshot is the cache at the moment it joins, and its live buffer keeps only rows with a later timestamp. If a timestamp's rows arrive in chunks and the client joins between them, it never gets the rest. The likeliest case is a second client joining while the first is still loading the initial snapshot, which is all one timestamp. The tests miss it because they write one row per statement and join after a small snapshot. Pushdown removes the shared snapshot. (A good opening example for post 4's model checker.)
- **`key_violation` is treated as an upsert** (`src/database/materialize.ts`). Dropping the envelope, and ending the subscription when a key isn't unique, fixes it.
- **`COPY` text isn't unescaped,** so backslashes, tabs and newlines in strings arrive as escape sequences. `FETCH` returns typed rows, so the parser goes.
- **Not a bug, but a gap:** clients get each row as it arrives, so they can see half of a timestamp. Buffering to progress closes it.

### Also carried over

- **The custom end-to-end harness stays for post 2,** because it tests through GraphQL clients against a real Materialize, which is what shows the change is invisible to clients. It goes in post 4.
- **Queries per view (step 7)** share their subscription's name, as Hasura's do; GraphQL allows a query and a subscription with the same name.
- **`docs/design/calculated_states.md` and `timestamp_propagation.md`** mention triggers; Chris keeps them until the Restate work is done.

## Architecture after the change

```
GraphQL (Yoga) ── resolver ──► subscribe(view, where)
                                 │
                                 ├─ database/query.ts    where → SELECT … WHERE (Kysely, compile-only)
                                 ├─ database/reader      own pg.Client, DECLARE/FETCH loop → raw rows
                                 └─ database/changes.ts  per-timestamp pairing → INSERT/UPDATE/DELETE
                                 ▼
                         Repeater → SSE to the client
```

- **`src/config/`** loads the database settings and `schema.yaml`, unchanged.
- **`src/database/`** holds everything that knows SQL or Materialize's output:
  - a `DatabaseModule` with the pool provider;
  - `query.ts`, which compiles a `where` filter to SQL and validates it as it goes (step 2);
  - `changes.ts`, the pure change processor (step 3);
  - the Materialize reader, in `materialize.ts` in place of today's COPY handler, which owns one connection, the `DECLARE`/`FETCH` loop and cleanup, and yields one complete timestamp of `{ diff, row }` at a time (step 4).
- **`src/common/types.ts`** holds what both layers share: the `where` operators and types, and the row events.
- **`src/api/`**: schema generation (unchanged), subscription resolvers built on a `Repeater`, and, from step 7, query resolvers.
- **Gone:** `src/view/` (shared sources, the cache, JavaScript filtering), the JavaScript filter compiler, `pg-copy-streams`, the COPY parser, `rxjs-for-await`.

## Other databases

tycostream only supports Materialize, but the new code keeps Materialize's specifics in one place, so another streaming database could be added later.

- **Database-neutral:** `query.ts` writes Postgres-dialect SQL, and `changes.ts` pairs rows that each carry a +1 or -1 (`{ diff, row }`).
- **Materialize-specific, all in the reader (step 4, `materialize.ts`):** `DECLARE … CURSOR FOR SUBSCRIBE`, `FETCH`, the `mz_timestamp`, `mz_progressed` and `mz_diff` columns, and buffering each timestamp until progress passes it. The reader sits behind a small interface that yields one complete batch of `{ diff, row }` at a time; another database would be another implementation of it.
- **RisingWave, as of the 5 Nov research (to re-check before relying on it):** its subscription cursors mark each row with an `op` (Insert, Delete, UpdateDelete, UpdateInsert), which maps onto +1 and -1, so `changes.ts` would work as it is. But it can't subscribe to an ad hoc query, only to an existing table or materialized view, so a client's `where` couldn't be pushed down; tycostream would have to check it in memory, which is the evaluator post 4 brings back anyway.

## Sequence

One commit per step, merged without squashing. Tests for each step are agreed with Chris before it starts. This sequence replaces the step list for post 2's code in `ideas.md`.

0. **This plan,** and the tag `shared-cache` on `main` before the hollow-out (done 6 Nov), so post 2's aside and post 4 can point at the old design.
1. **The late-joiner test,** marked `it.fails`: one statement inserts thousands of rows, and a second client subscribes while the first is still loading them. Expected to fail today; it must pass at step 6.
2. **The SQL compiler,** beside today's JavaScript one, with unit tests: quoting hostile names, parameters, every operator, nesting, `_not`, empty `_in`/`_nin`, enum values. Nothing uses it yet.
3. **The change processor,** with unit tests: insert, update with changed fields, delete, netting, several keys in one timestamp, rows in any order, entering and leaving a filter, key violations.
4. **`SubscribeReader`,** with integration tests against Materialize in Testcontainers: rows arrive typed, parameters bind, progress arrives when idle, and after cleanup `mz_internal.mz_subscriptions` is empty.
5. **The pushdown path behind a setting** (`SUBSCRIPTION_MODE=pushdown`): resolver → compiler → reader → processor → `Repeater`. The end-to-end harness runs against both paths. A database error ends one subscription, not the server.
6. **Switch over.** Pushdown becomes the only path. Delete `src/view/`, the JavaScript compiler, the COPY parser, the setting, `pg-copy-streams` and `rxjs-for-await`. The late-joiner test now passes, so it becomes a normal `it`.
7. **Queries per view:** `trades(where: …)` returns the current rows through the pool, as a plain `SELECT`. Then remove the placeholder `ping` query.
8. **Lint:** type the remaining `any` boundaries and make the `no-unsafe-*` rules errors again.
9. **Docs and release.** README, `architecture.md`, `roadmap.md`, a pass over `docs/design/`, then release `v0.3.0`.

## Enums

They stay declared in `schema.yaml`, as today (Chris, 6 Nov). Materialize has no enum types, and nothing in its catalog marks a text column as one.

## Risks

- **Bind parameters in `DECLARE` are undocumented.** Pinned by a test, with `escapeLiteral` as the fallback.
- **Each subscription is its own dataflow.** A filtered subscription on a plain (unindexed) view recomputes the view from scratch. Mitigation: serve only indexed or materialized views, and say so in the docs.
- **Connections scale with subscriptions.** 5,000 on the emulator; a cap in tycostream may be needed later.
- **Progress cadence.** Progress arrives about once a second on the emulator; views whose frontier stalls (for example `REFRESH EVERY`) would hold changes back until it moves.
- **Slow clients.** A client that can't keep up eventually gets error 53200 from Materialize; until then its rows queue inside Materialize, not tycostream.

## Decided in review (Chris, 6 Nov)

1. **SQL building:** Kysely, compile-only.
2. **Catalog discovery:** not in this branch; `schema.yaml` stays the contract (D9).
3. **Enums:** stay in `schema.yaml`.
4. **A cap on concurrent subscriptions:** later, with post 4's fan-out work.
