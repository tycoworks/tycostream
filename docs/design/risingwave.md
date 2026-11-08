# RisingWave support

Status: not built. Research as of 5 Nov 2026; re-check before relying on it.

## How it would fit

RisingWave speaks the Postgres protocol and reads subscriptions through cursors, so it would be a second adapter: a `RisingWaveAdapter` that reads snapshots with the same `readSnapshot` as Materialize's (`postgres.ts`, [queries.md](./queries.md)) and live streams its own way, with no change to `DatabaseStream`, which only holds the connection. `DatabaseModule`'s adapter provider would pick it from a setting such as `DATABASE_TYPE`. `schema.yaml` stays the same for both.

## How its live reading would differ

- **Create a subscription object, then a cursor on it.** `CREATE SUBSCRIPTION` on a table or materialized view, then `DECLARE … SUBSCRIPTION CURSOR FOR` it. Each client needs a uniquely named subscription, and the adapter must drop it at the end: unlike Materialize's `SUBSCRIBE`, closing the connection doesn't remove it.
- **Fetch with a timeout.** The 5 Nov research found that `FETCH` without a timeout returns at once, so it would fetch `WITH (timeout = …)` to avoid spinning. (An earlier note said it blocks until rows exist; one of the two is wrong.)
- **Decide when a timestamp is complete another way.** There are no progress rows.
- **Build events straight from each row's `op`:** `Insert`, `Delete`, and an `UpdateDelete`/`UpdateInsert` pair for an update. No netting or pairing by key, which only Materialize's bare diffs need.

## What it can't do

**Subscribe to an ad hoc query.** It subscribes only to an existing table or materialized view, so a client's `where` can't be pushed down. tycostream would check it in memory in the view layer, which is the evaluator a shared cache brings back anyway.

## Defaults

Port 4566, user `root`, no password, database `dev`.
