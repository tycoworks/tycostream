# Relationships between sources

Status: proposed, 10 Nov 2026; replaces the 8 Nov draft. Branch: `relationships`.

## Goal

positions-app opens one subscription and gets its positions with each one's trades nested under it, one message per timestamp, so a position and its trades never disagree. Today it opens two, one on `live_pnl` and one on the selected position's `trades`. `live_pnl` is computed from `trades`, so a new trade and the change it makes to its position arrive on different subscriptions, and the grids can show one without the other.

## How Hasura does it

- **Declared per table, by name, one direction at a time.** An *object* relationship (at most one related row) or an *array* relationship (any number); the reverse is declared on the other table [1][7]. A view has no foreign keys, so it takes a `manual_configuration`: the target and a `column_mapping` from this table's columns to the target's. Hasura doesn't check a manual mapping [2].
- **GraphQL:** a nested field of the relationship's name. An array field takes `where`, `order_by`, `limit` and `offset`, applied per parent row, and has an `_aggregate` twin; an object field takes no arguments [3].
- **Filters** can go through a relationship: the one related row matches, or any of them does [4].
- **Queries** become one SQL statement, which builds the nested JSON in Postgres [5][6].
- **Subscriptions** are live queries: Hasura re-runs the whole query and sends the whole result when it has changed [8][9]. Streaming subscriptions send only the new rows of an append-only table [10]. Neither sends row-level changes across a relationship.

## The API

Hasura's declaration, field names and arguments; our own subscription format, as now.

### `schema.yaml`

```yaml
sources:
  live_pnl:
    primary_key: instrument_id
    columns: { ... }
    relationships:
      trades:                  # the GraphQL field
        type: array            # Hasura's kinds; object comes later
        source: trades         # the target
        column_mapping:        # this source's column: the target's
          instrument_id: instrument_id
```

This is our own format, not a copy of Hasura's metadata, which leaves out what Hasura reads from the database (columns, types, keys); a view has no keys to read. Checked at startup:

- the target source exists;
- each mapped column exists on both sides, with the same type;
- the name isn't one of the source's columns, nor `operation`, `data` or `fields` (the update type's own fields).

### Queries: as Hasura

```graphql
query {
  live_pnl {
    symbol
    net_position
    trades(order_by: {executed_at: desc}, limit: 20) { id quantity price }
  }
}
```

`live_pnl.trades(where, order_by, limit, offset): [trades!]!`, with the arguments applied per position. A Hasura query that uses array relationships runs unchanged.

### Subscriptions: every level is a list of updates

```graphql
subscription {
  live_pnl {
    operation
    fields
    data { instrument_id symbol net_position }
    trades(order_by: {executed_at: desc}, limit: 20) {
      operation
      fields
      data { id quantity price }
    }
  }
}
```

An array relationship is a field of the update type, beside `data`: `live_pnl_update.trades(where, order_by, limit, offset): [trades_update!]!`. Each level's selection inside `data` is a Hasura selection; what's around it is ours. The message for one timestamp, here a new AAPL trade with `limit: 2`:

```json
[
  {
    "operation": "UPDATE",
    "fields": ["instrument_id", "net_position"],
    "data": { "instrument_id": 1, "net_position": 700 },
    "trades": [
      { "operation": "INSERT", "fields": ["id", "quantity", "price"], "data": { "id": 8, "quantity": 100, "price": 201 } },
      { "operation": "DELETE", "fields": ["id"], "data": { "id": 2 } }
    ]
  }
]
```

The rules:

- **A parent's INSERT carries its children,** as INSERTs. The snapshot is the whole tree.
- **A parent's UPDATE carries its children's changes at that timestamp,** if any. A parent whose children changed but which didn't change itself arrives as an UPDATE of its key alone.
- **A parent's DELETE carries no children:** they go with it.
- **A child always arrives under its parent,** which the client already has, or gets in the same message.
- **Lists are unordered,** as now; `order_by`, `limit` and `offset` choose the rows, per parent.
- **`data` keeps the query's row type,** so `data { trades { … } }` is valid GraphQL. In a subscription it's an error, which says to select `trades` beside `data`.

Beside `data`, not inside it, because inside it `trades` would need a second row type per source, to hold updates rather than rows. Beside it, every type stays as it is and every level has the same shape.

## Execution

### Select only what's selected

The API reads the operation's selection: the columns, and each relationship with its arguments, under its response key. Two aliases of one relationship can take different arguments, so each alias is its own level, and a relationship field resolves by its alias. The SQL selects only the selected columns, and the key. graphql 17 exports what this needs, `getArgumentValues` and `getDirectiveValues` (for `@skip` and `@include`); walking fragments is ours.

### One statement per stream

One CTE per level: the root's selection, then each nested level joined `LATERAL` to its parent's CTE, with its own filter, order, limit and offset, per parent. The output is a `UNION ALL` of the levels. Each row is tagged with its level and carries its ancestors' keys. The other levels' columns are null, cast to their types, so node-postgres parses every column by its type, as now.

```sql
WITH l0 AS (
  SELECT instrument_id, symbol, net_position FROM live_pnl
),
l1 AS (
  SELECT p.instrument_id AS k0, t.id, t.quantity, t.price
  FROM l0 p, LATERAL (
    SELECT id, quantity, price FROM trades
    WHERE trades.instrument_id = p.instrument_id
    ORDER BY executed_at DESC LIMIT 20
  ) t
)
SELECT 0 AS level, instrument_id AS k0, symbol, net_position,
       NULL::int4 AS id, NULL::int4 AS quantity, NULL::numeric AS price
FROM l0
UNION ALL
SELECT 1, k0, NULL::text, NULL::int8, id, quantity, price FROM l1
```

- **A query** `SELECT`s it, with each level's `row_number()` for its order, and tycostream assembles the tree. One statement is one consistent read in any database, without a transaction, and Postgres has all of it.
- **A subscription** `SUBSCRIBE`s the same statement, without the order columns, so every level is at one timestamp. A query's result and a subscription's snapshot are the same rows by construction.
- **Per timestamp,** each level's rows are paired by their ancestors' keys and their own key, as rows are paired by key now. Then each child's event goes under its parent's event. A parent with no event gets an UPDATE of its key alone. A child under a parent's DELETE is dropped. Nothing is kept between timestamps, as now.

### Checked against Materialize v26.49 (10 Nov)

- `SUBSCRIBE` takes the statement: CTEs, a `LATERAL` top 2 per parent, and `UNION ALL`.
- A change to a parent's other columns, as a price tick, sends only the parent's row. Its children's rows carry only its key, so they don't change.
- A new trade sends the position's change, the new trade, and the trade it pushed out of the top 2, at one timestamp.
- A position entering or leaving the root's top N brings or takes its trades, at the same timestamp.
- A change to a column that isn't selected sends nothing.
- `row_number()` gives each level's order in a `SELECT`.
- For later: `EXISTS` filters work under `SUBSCRIBE`. A `LEFT JOIN` for an object relationship works, and a price tick then repeats for every one of that position's trades. `jsonb_agg` exists; `json_agg` doesn't.

### Not chosen

- **The whole list in `data` whenever it changes,** as a live query does for its whole result. tycostream would have to keep every parent's children between timestamps to resend them, and every new trade would resend all of its position's trades.
- **`jsonb_agg` in Materialize:** the same resending, done in Materialize, and values arrive as JSON, not typed by their column.
- **One `SUBSCRIBE` per level, merged by timestamp:** a connection per level, a shared `AS OF` to choose, and progress to merge. One statement gets one timestamp from Materialize for free.
- **One flat join:** a position's change repeats for every one of its trades.

## Steps

Each its own pull request, and each useful on its own.

1. **Select only what's selected.** The API reads the selection; the SQL selects its columns and the key; `fields` lists only selected columns. On its own: a subscription stops getting updates for columns it didn't select. Today `live_pnl { data { symbol } }` gets one at every price tick, though nothing it selected changed. Tests: reading the selection, with fragments, aliases, `@skip` and `@include`, and variables; end to end, a price tick sends nothing to a subscription of `symbol`.
2. **Array relationships in queries.** `relationships` in `schema.yaml` and its checks; the row type's fields; the statement; assembling the tree in order. On its own: Hasura's nested queries, one consistent read in one round trip. Tests: the checks and the SQL; end to end, nested `where`, `order_by`, `limit` and `offset`, two aliases with different arguments, empty lists, two levels.
3. **Array relationships in subscriptions.** The update type's fields, nesting each timestamp's events, and the error for a relationship inside `data`. The goal. Tests end to end: a price tick (parent only); a new trade (parent and child at one timestamp); a position entering and leaving the top N with its trades; aliases; two levels.
4. **positions-app on one subscription,** after releasing tycostream. It keeps each position's trades and shows the selected one's; each message is one transaction per grid.

## Later

On the roadmap, not needed for the goal:

- **Object relationships** (`trades.position`): a `LEFT JOIN` onto the row, a nested object in `data` that changes as a whole. It must map onto the target's primary key, so it never finds two rows.
- **Filtering by relationships** (`EXISTS`), and ordering by an object relationship's columns.
- **Aggregates** (`trades_aggregate`).

## Open questions

- **Depth.** A query sets its own; each level adds a join and a top-K per parent to the subscription's dataflow. No cap unless measuring says so.
- **What Materialize keeps** per nested subscription: to measure in step 3, with positions-app.
- **positions-app's trades:** all of them, or the latest few per position.

## Sources

1. https://hasura.io/docs/2.0/schema/postgres/table-relationships/create/
2. https://hasura.io/docs/2.0/api-reference/metadata-api/relationship/
3. https://hasura.io/docs/2.0/queries/postgres/nested-object-queries/
4. https://hasura.io/docs/2.0/queries/postgres/filters/using-nested-objects/
5. https://hasura.io/blog/architecture-of-a-high-performance-graphql-to-sql-server-58d9944b8a87
6. https://hasura.io/docs/2.0/api-reference/explain/
7. https://hasura.io/docs/2.0/schema/postgres/table-relationships/index/
8. https://hasura.io/docs/2.0/subscriptions/postgres/index/
9. https://hasura.io/docs/2.0/subscriptions/postgres/livequery/execution/
10. https://hasura.io/docs/2.0/subscriptions/postgres/streaming/index/
