# Architecture

## Overview

tycostream turns database views into GraphQL queries and subscriptions. Each source in `schema.yaml` gets a query of its current rows and a subscription to them and every change, with its related sources' rows nested in either. Each client's subscription is pushed down to Materialize as its own `SUBSCRIBE` of one statement, every level of the nesting included, and each query as that statement's plain `SELECT`. So Materialize does the filtering, the joins and the snapshot, every level of a message is at one timestamp, and tycostream holds no rows beyond the changes it's passing on.

**Sources, views and streams.** A *source* is whatever tycostream reads from: a table or view in the database, as listed in `schema.yaml`. (Not a Materialize `SOURCE`, which brings data into Materialize.) A *view* is one client's window onto a source: a source plus a selection. A *stream* is one running read of a view, in a mode: `Snapshot` (the current rows, then it ends) or `Live` (the current rows, then every change). Only the API speaks of queries and subscriptions; below it, a GraphQL query is a `Snapshot` stream and a subscription a `Live` one.

**Relationships, paths and keys.** A *relationship* is a field that reaches another source's rows: to one row, as a trade's position, or to many, as a position's trades. Each foreign key in `schema.yaml` gives both. GraphQL calls a relationship to many rows' rows a *list*; the database layer reads them as a *related source*, a source of its own, and a relationship to one row as a *related row*, joined onto its row. A row's *path* is the fields from a selected row to it: `[]` for a position, `["trades"]` for one of its trades. Its *keys* are its selected row's key, then one per relationship to many rows on its path: `[1]` for position 1, `[1, 8]` for its trade 8.

The design and its reasons are in [design/hollow-out.md](./design/hollow-out.md), and for relationships in [#2](https://github.com/tycoworks/tycostream/issues/2).

## Technology Stack

- **Runtime**: Node.js with TypeScript, as ES modules
- **Framework**: NestJS for modules and dependency injection
- **GraphQL Server**: @nestjs/graphql with GraphQL Yoga (subscriptions over SSE)
- **Database Client**: node-postgres (Materialize speaks the Postgres wire protocol)
- **SQL**: Kysely, used only to compile statements to SQL with bind parameters
- **Streaming**: Repeater (async iterators that clean up as soon as the client goes)
- **Schema**: GraphQL schema generated at startup from `schema.yaml`
- **Configuration**: @nestjs/config with class-validator

## Component Architecture

Three layers, each a Nest module that depends only on the one below.

```
client ─GraphQL─▶ API ─Selection─▶ view ─▶ database ─SQL─▶ Materialize
client ◀─JSON──── API ◀─flat changes── view ◀─ database ◀─rows─
```

**A tree goes down, flat changes come up,** as SQL takes a nested question and gives flat rows. The API never sees SQL, and the database layer never builds a tree.

- **Down, a `Selection`:** a source's columns, `where`, `order_by`, `limit` and `offset`, and each relationship as a selection of its own, at any depth.
- **Up, `RowUpdateEvent`s:** one per row, one complete timestamp at a time, a snapshot as one timestamp of inserts. Each has its type (INSERT, UPDATE or DELETE), its path and keys, the fields it names, and its row, flat: a related row's columns named by their path, as `positions.symbol`. What both layers rely on is stated once, on the type in `common/types.ts`: at most one change per path and keys at a timestamp; a query's changes in the selection's order; a related row whose columns are all null matched nothing.

### Database Module (`src/database/`)

Connections and the database. Nothing above it sees SQL or how the database reports changes.

- **`DatabaseService`** is the layer's one export: `stream(source, selection, mode)`. It builds the selection into a `Statement`, opens a `DatabaseStream` of it, and closes any open streams first thing at shutdown.
- **`Statement`** (`statement.ts`, with `filter.ts` for each `where`) is one SQL statement reading a selection at every level, and unpacks its rows. See below.
- **`DatabaseStream`** (`stream.ts`) is one stream: it borrows a connection for its mode on the first read, has the adapter read the stream in that mode, passes on what it reads, and gives the connection back when the stream ends, with the error if it failed. Stopping it cancels the connection at once, even mid-statement.
- **`DatabaseConnectionService`** (`connection.service.ts`) is the one place connections are made: one pool, capped at `DATABASE_MAX_CONNECTIONS`, lending to streams of both modes. A `Live` stream holds its connection until it stops, and it's then discarded, which drops its `SUBSCRIBE`; a `Snapshot` borrows one for one `SELECT`, gives it back for reuse, and is cut off after `DATABASE_QUERY_TIMEOUT_MS`, waiting included. When every connection is taken, a new stream waits for a free one, up to the connect timeout. It stops lending once shutdown starts, and ends the pool last.
- **`DatabaseAdapter`** is the database: one `read(client, statement)`, in the statement's mode. `DatabaseModule` provides `MaterializeAdapter`; another database would be another adapter, chosen there.
- **`MaterializeAdapter`** (`materialize.ts`) reads a snapshot with `readSnapshot`, and a live stream through `DECLARE … CURSOR FOR SUBSCRIBE (…) WITH (SNAPSHOT, PROGRESS)` and a `FETCH` loop, holding each timestamp's rows until a progress row passes it, then pairing them into changes by path and keys.
- **`postgres.ts`** is what every Postgres-compatible database does the same way: values sent as text, typed by the schema (`TYPE_PARSERS`, `parseText`), and a snapshot as one plain `SELECT` (`readSnapshot`), each row an insert.

#### The statement

`new Statement(source, selection, mode)` builds every statement the same way, with or without relationships:

- **Sources:** the selected rows, then each related source in them, at any depth, parents first, each read as a CTE of its own. A related source's rows are read `LATERAL` for each row of their parent, with their own filter, order, limit and offset per parent, and carry the parent's keys as `__key_0`, `__key_1`….
- **Related rows** are `LEFT JOIN`ed onto their row after the row's own filter, order and limit, so Materialize's top N holds only the rows it keeps. A join's column is read even when it isn't selected, and stays out of the row.
- **Every row** comes out of one `UNION ALL` as four columns: `__source`, its source's number in the plan; `__row_number`, in a query only, which orders it; `__keys`, a JSON array; and `__row`, a JSON object of its columns. Each value goes into the JSON as the text the database would send for it. The JSON is built in the `UNION ALL`, never under a `LIMIT`, where Materialize would hold it rather than the values.
- **`unpack(row)`** reads one row back: its path, from its source's number, and its keys and columns, each parsed by the type `schema.yaml` gives it.

The names the statement adds all start with `__`, which GraphQL reserves, so none can be a source's, a column's or a path's; a path's fields are joined by `.`, which no GraphQL name contains. A query and a subscription's snapshot are the same rows by construction.

**Pairing.** Materialize's `SUBSCRIBE` sends bare diffs, so its adapter nets identical rows, then pairs each path and keys' rows: a +1 alone is an INSERT, a −1 alone a DELETE, a −1 and a +1 an UPDATE of the columns that differ. Anything else, or a query with a path and keys twice, is a `KeyViolationError`: a declared key, a parent's or a related row's, isn't unique. Pairing is Materialize's; a database that sends each row's operation, such as RisingWave, would need none.

### View Module (`src/view/`)

The domain layer. `ViewService` is a pass-through to the database layer for now; it's where a shared cache, filtering in memory, or permissions would go, working on the `Selection`.

### API Module (`src/api/`)

- **`schema.ts`** generates the GraphQL schema from `schema.yaml`: per source, a type, an update type, a filter input, an order input, a query returning its rows, and a subscription returning its updates. A relationship to one row is a field of the source's type; one to many rows is a list, taking `where`, `order_by`, `limit` and `offset`, in the source's type and, of updates, in its update type beside `data`.
- **`api.resolver.ts`** builds each source's resolvers. It reads the operation into a `Selection` with GraphQL's own field collection (fragments, `@skip`, `@include`) and `getArgumentValues`: a query's selection set, or a subscription's update type, `data`'s columns and related rows and each list beside it. Aliases of one relationship merge; with different arguments they're refused, and so is a list inside a subscription's `data`. Each list has a resolver giving `[]` when a row or update has none. A subscription resolver hands GraphQL the service's iterator directly, so a client that disconnects closes its database connection at once; a query resolver passes on the request's signal, which aborts when the client leaves, so the query ends in the database.
- **`ApiService`** (`api.service.ts`) is the layer's one service. `query` opens a `Snapshot` stream on the view and returns its rows; `subscribe` opens a `Live` stream and sends each timestamp's updates.
- **`tree.ts`** builds the responses from the flat changes, with the source's relationships to tell a list from a related row on a path:
  - each related row's columns are folded into an object, null when it matched nothing;
  - each list's row or update goes under its parent's, found by its path and keys, the keys less their last;
  - in a subscription, a parent with no change of its own gets an UPDATE of its key alone, so a parent's INSERT carries its rows' INSERTs, its DELETE their DELETEs, and its UPDATE their changes;
  - an update sends only the fields its change names, a related row as one field, sent whole. `toRows` gives a query's answer, `toUpdates` a subscription's message.

### Configuration & Common (`src/config/` and `src/common/`)

- Database and GraphQL settings, validated at startup
- `schema.yaml` loading and validation, with each foreign key's two relationships (`addForeignKey`)
- The `Selection`, the `where` operators and the row events the layers share
- Logging helpers

## Data Flow

1. **A client subscribes** over SSE, with an optional `where`, `order_by`, `limit` and `offset`, at any level. (A query follows the same path as a `Snapshot` stream, which ends after step 3's snapshot.)
2. **The selection becomes one statement.** The resolver reads it, it passes through the view layer to `DatabaseService`, which builds it into SQL with every value a bind parameter. An invalid selection fails here, before any connection opens.
3. **The client gets its own connection from the pool, and its own `SUBSCRIBE`.** Materialize sends the matching rows at every level as of one timestamp (the snapshot), then every change after it, with a progress row whenever a timestamp is complete.
4. **Each complete timestamp becomes changes.** The rows are unpacked, identical rows netted, then each path and keys' −1 and +1 paired. A row entering or leaving a filter or a limit, at any level, arrives as a lone +1 or −1, so it's an insert or a delete.
5. **The client gets each timestamp's changes** as one message of GraphQL updates, nested. A slow client holds the next `FETCH` back, so its backlog queues in Materialize, which caps it.
6. **The client disconnects,** and its connection is discarded, which drops the `SUBSCRIBE` in Materialize.

A database error, or a source whose key turns out not to be unique, ends that one query or subscription with a GraphQL error. The server keeps running.

## Key Design Decisions

The full lists are in [design/hollow-out.md](./design/hollow-out.md#decisions) and, for relationships, [#2](https://github.com/tycoworks/tycostream/issues/2). The main ones:

### Why one `SUBSCRIBE` per client?

- Materialize already filters, snapshots and orders changes per query; tycostream doesn't have to repeat it.
- No shared cache means no late-joiner races and no copy of every row in tycostream.
- The cost moves to Materialize: a connection and a dataflow per client. Serve indexed or materialized views, so each subscription doesn't recompute its view from scratch.

### Why one statement for every level?

- One `SUBSCRIBE` gets one timestamp for free: a new trade and the change it makes to its position arrive in one message. A `SUBSCRIBE` per source would need a connection each, and their progress merged.
- A related source's rows carry only their parent's keys, so a change to a position sends the position's row alone, not each of its trades again.

### Why rows of JSON, and not nested JSON built in Materialize?

- Materialize can't update a list's JSON in place, so any change would rebuild it, and `SUBSCRIBE` would send it twice, old and new: a new trade among 5,000 sent 1.57 MB, measured.
- JSON is how databases return rows of different shapes in one result; the values go in as text, so the existing parsers type them.

### Why flat changes up, and the tree in the API?

- The tree is GraphQL's shape; built in the database layer, a cache in the view layer would have to undo it.
- Each change's path and keys say where it goes, so the API needs no state to place it.

### Why raw diffs and progress rows?

- The −1 carries the old row, so updates and deletes need no cache.
- Waiting for progress means a client never sees half a timestamp.

### Why `Repeater` and not RxJS?

- A `Repeater` cleans up the moment the client goes, even on a quiet view, and its `push` waits for the client, so a slow client's backlog stays in Materialize.
- RxJS can come back for sharing between clients, which is what it's good at.

### Why single process?

- Less to operate; Materialize does the heavy lifting and scales on its own.

## Future Evolution

- **Sharing between clients** with identical or overlapping filters, model-checked
- **Permissions** in the view layer
- **Monitoring**: OpenTelemetry instrumentation points
