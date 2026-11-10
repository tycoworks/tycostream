# Relationships between sources

Status: agreed, 10 Nov 2026. Step 1 done ([#22](https://github.com/tycoworks/tycostream/pull/22)). Branch: `relationships`.

## Goal

positions-app opens one subscription and gets its positions with each one's trades nested under it, one message per timestamp, so a position and its trades never disagree. Today it opens two, one on `positions` and one on the selected position's `trades`. `positions` is computed from `trades`, so a new trade and the change it makes to its position arrive on different subscriptions, and the grids can show one without the other.

The other direction comes too: a trade showing its position, as a trade blotter would.

## How Hasura does it

- **Two kinds, declared per table, by name.** An *object* relationship (at most one related row) or an *array* relationship (any number) [1][7].
- **From a foreign key,** Hasura reads the mapping, and its console suggests both relationships, with names such as `userByuserId` that people rename [11]. A view has no foreign keys, so each relationship is declared by hand, as a `manual_configuration`: the target and a `column_mapping` [2].
- **GraphQL:** a nested field of the relationship's name. An array field takes `where`, `order_by`, `limit` and `offset`, applied per parent row, and has an `_aggregate` twin; an object field takes no arguments [3].
- **Filters** can go through a relationship: the one related row matches, or any of them does [4].
- **Queries** become one SQL statement, which builds the nested JSON in Postgres [5][6].
- **Subscriptions** are live queries: Hasura re-runs the whole query and sends the whole result when it has changed [8][9]. Streaming subscriptions send only the new rows of an append-only table [10]. Neither sends row-level changes across a relationship.

## The API

Hasura's fields and arguments; our own subscription format, as now.

### `schema.yaml`: foreign keys

`schema.yaml` describes the database in Postgres's terms: what Postgres would say of a view if it could, its key and its columns' types. A relationship is a foreign key:

```yaml
sources:
  trades:
    primary_key: id
    columns: { ... }
    foreign_keys:
      instrument_id: positions   # REFERENCES positions, its primary key
```

As in Postgres, a foreign key without columns references the target's primary key; a key here is one column. One foreign key gives both relationships, each named after the other source:

- `trades.positions`, an object relationship: the trade's position;
- `positions.trades`, an array relationship: the position's trades.

At startup, tycostream derives both from each foreign key, once: each relationship is the other source, the column on each side that the join matches, and whether it holds one row or many. The two share one join condition, `trades.instrument_id = positions.instrument_id`; only one or many differs, and the rest of tycostream follows from that. Reading a foreign key looks up its column and the referenced source, and says which is missing; two foreign keys from one source to another would give two relationships of one name, and say so too. A relationship named like a column, or like the update type's `operation`, `data` or `fields`, makes two fields of one name, which GraphQL refuses at startup. Types aren't compared: Postgres allows a foreign key between comparable types, such as `int4` and `int8`, and Materialize rejects a join of types it can't compare.

### Object relationships

```graphql
query {
  trades { id quantity price positions { symbol net_position latest_price } }
}
```

`trades.positions: positions`, null when no position matches. In a subscription it's a field inside `data`, like a column: when any of its selected columns changes, the update lists `positions` in `fields` and sends the whole object. Only the selected columns are joined, so a blotter that shows `positions { symbol }` gets nothing at a price tick; one that selects `latest_price` gets an update for every trade of that position, as it asked.

### Array relationships in queries: as Hasura

```graphql
query {
  positions {
    symbol
    net_position
    trades(order_by: {executed_at: desc}, limit: 20) { id quantity price }
  }
}
```

`positions.trades(where, order_by, limit, offset): [trades!]!`, with the arguments applied per position. A Hasura query that uses relationships runs unchanged.

### Array relationships in subscriptions: every level is a list of updates

```graphql
subscription {
  positions {
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

An array relationship is a field of the update type, beside `data`: `positions_update.trades(where, order_by, limit, offset): [trades_update!]!`. Each level's selection inside `data` is a Hasura selection; what's around it is ours. The message for one timestamp, here a new AAPL trade with `limit: 2`:

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
- **`data` keeps the query's row type,** so `data { trades { … } }` is valid GraphQL, as is an array relationship inside an object relationship there. In a subscription either is an error, which says to select `trades` beside `data`.

Beside `data`, not inside it, because inside it `trades` would need a second row type per source, to hold updates rather than rows. Beside it, every type stays as it is and every level has the same shape.

## Execution

### Reading the selection

The resolver reads the operation's selection with GraphQL's own field collection, `collectSubFields` from `@graphql-tools/utils`, which follows fragments and applies `@skip` and `@include`, and an array relationship's arguments with graphql's `getArgumentValues`. The selection becomes a tree: the columns, each object relationship's selection by name, and each array relationship's selection under its response key. Two aliases of one array relationship can take different arguments, so each alias is its own level, and the field resolves by its alias. The SQL selects only the selected columns, and the keys.

### Object relationships: a join onto the row

Each selected object relationship is a `LEFT JOIN` of its source on the foreign key, onto the row it hangs from, at any depth. Its selected columns, and its key, come back in that row under their own names, and tycostream folds them into the nested object, null when the key is null. The key is the referenced source's primary key, so the join never finds two rows. In a subscription the object is one more value of the row, so pairing and `fields` work as now.

### Array relationships: one statement per stream

One CTE per level: the root's selection, then each nested level joined `LATERAL` to its parent's CTE, with its own filter, order, limit and offset, per parent. The output is a `UNION ALL` of the levels. Each row is tagged with its level and carries its ancestors' keys. The other levels' columns are null, cast to their types, so node-postgres parses every column by its type, as now.

```sql
WITH l0 AS (
  SELECT instrument_id, symbol, net_position FROM positions
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
- A `LEFT JOIN` for an object relationship works under `SUBSCRIBE`; a price tick then changes every one of that position's trades.
- `row_number()` gives each level's order in a `SELECT`.
- For later: `EXISTS` filters work under `SUBSCRIBE`. `jsonb_agg` exists; `json_agg` doesn't.

### Not chosen

- **`relationships` with `type: object` or `type: array` in `schema.yaml`:** those describe the API, and the file describes the database.
- **The whole list in `data` whenever it changes,** as a live query does for its whole result. tycostream would have to keep every parent's children between timestamps to resend them, and every new trade would resend all of its position's trades.
- **JSON built in Materialize, with `jsonb_agg`:** the same resending: one new trade rebuilds its position's whole list, and the subscription sends it twice, old and new. And values arrive as JSON, which skips tycostream's conversions by column type: a timestamp inside JSON is `2025-06-02 10:00:00`, not the ISO form served elsewhere.
- **One `SUBSCRIBE` per level, merged by timestamp:** a connection per level, a shared `AS OF` to choose, and progress to merge. One statement gets one timestamp from Materialize for free.
- **One flat join for an array relationship:** a position's change repeats for every one of its trades, and two lists under one position multiply, 10 trades by 10 orders making 100 rows.
- **Blocks for object relationships too,** so every relationship goes one way: a trade with six lookups would be seven rows rather than one, and a lookup's block changes would need turning back into a field of the trade, each with its own case: a position appearing, going, or swapping for another, or arriving with a new trade. Joined, a lookup is one more value of the row, which the row's pairing, `fields`, inserts and deletes already handle; lists are blocks because they must be, and a block's rows carry their own lookups through the same join.

## Steps

Each its own pull request, and each useful on its own.

1. **Select only what's selected.** Done in [#22](https://github.com/tycoworks/tycostream/pull/22).
2. **Foreign keys, and object relationships,** in queries and subscriptions. `foreign_keys` in `schema.yaml`; the object relationships' fields; reading nested selections; the joins; folding the joined columns into objects. On its own: a live trade blotter that shows each trade's position. Tests: reading `foreign_keys`, and the SQL; end to end, a query and a subscription of `trades { positions { … } }`, a trade with no position, two levels, and a price tick that sends nothing unless `latest_price` is selected.
3. **Array relationships in queries.** The row type's fields; the statement; assembling the tree in order. On its own: Hasura's nested queries, one consistent read in one round trip. Tests: the SQL; end to end, nested `where`, `order_by`, `limit` and `offset`, two aliases with different arguments, empty lists, two levels.
4. **Array relationships in subscriptions.** The update type's fields, nesting each timestamp's events, and the error for an array relationship inside `data`. The goal. Tests end to end: a price tick (parent only); a new trade (parent and child at one timestamp); a position entering and leaving the top N with its trades; aliases; two levels.
5. **positions-app on one subscription,** after releasing tycostream. It keeps each position's trades and shows the selected one's; each message is one transaction per grid.

## Later

On the roadmap, not needed for the goal:

- **Filtering by relationships** (`EXISTS`), and ordering by an object relationship's columns.
- **Aggregates** (`trades_aggregate`).
- **Exposing a source under another name,** such as `positions` as `position`, which names its relationships too; and naming relationships, if two foreign keys between the same sources ever need it.

## Open questions

- **Depth.** A query sets its own; each level adds a join, and for an array relationship a top-K per parent, to the subscription's dataflow. No cap unless measuring says so.
- **What Materialize keeps** per nested subscription: to measure in step 4, with positions-app.
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
11. https://hasura.io/blog/graphql-schema-on-postgres-with-foreign-keys-and-without-foreign-keys-95f6b2715478
