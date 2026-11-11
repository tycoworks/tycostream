# Relationships between sources

Status: proposed, 10 Nov 2026, for review. Branch: `relationships-2`. Replaces the earlier drafts. The code on the `relationships` branch explored this design and is the reference for building it; the steps at the end build it again, in order.

## Goal

positions-app opens one subscription and gets its positions with each one's trades nested under it, one message per timestamp, so a position and its trades never disagree. Today it opens two subscriptions, one on `positions` and one on the selected position's `trades`. `positions` is computed from `trades`, so a new trade and the change it makes to its position arrive on different subscriptions, and the grids can show one without the other.

The other direction comes too: a trade showing its position, as a trade blotter would.

## Terms

Five, and no others:

- **Source:** a view or table in `schema.yaml`, as now.
- **Relationship:** a field that reaches another source's rows, to one row (a trade's position) or to many (a position's trades).
- **Path:** the fields from a selected row to a row, as GraphQL uses the word: `[]` for a position, `["trades"]` for one of its trades.
- **Keys:** a row's keys from the selected row down: `[1]` is position 1, `[1, 8]` its trade 8.
- **Row number:** SQL's `row_number()`, which keeps a query's rows in order.

## How Hasura does it

- **Relationships** are declared per table, by name: an object relationship (at most one row) or an array relationship (any number) [1][7]. A foreign key suggests both; a view, having no foreign keys, declares them by hand [2][11].
- **GraphQL:** a nested field of the relationship's name. A relationship to many rows takes `where`, `order_by`, `limit` and `offset`, applied per parent row [3].
- **Queries** become one SQL statement that builds the nested JSON in Postgres; the server passes it on untouched [5][6]. Only remote joins nest on the server, above the database, by keys carried in the rows [12].
- **Subscriptions** re-run the whole query and send the whole result when it changes; streaming subscriptions send only an append-only table's new rows [8][9][10]. Neither sends row-level changes across a relationship, so the rules for those below are tycostream's own.

## The API

Hasura's fields and arguments; tycostream's subscription format, as now.

### `schema.yaml`: foreign keys

`schema.yaml` describes the database in Postgres's terms, so a relationship is a foreign key:

```yaml
sources:
  trades:
    primary_key: id
    columns: { ... }
    foreign_keys:
      instrument_id: positions   # references positions' primary key
```

One foreign key gives two relationships, each named after the other source:

- `trades.positions`, to one row: the trade's position;
- `positions.trades`, to many rows: the position's trades.

Both share one join condition, `trades.instrument_id = positions.instrument_id`; only one or many differs. At startup, tycostream checks the column and the referenced source exist, and refuses two relationships of one name, as two foreign keys between the same sources would give. A relationship named like a column makes two fields of one name, which GraphQL refuses at startup; so does a relationship to many rows named `operation`, `data` or `fields`.

### Queries

```graphql
{
  positions(order_by: [{ symbol: asc }]) {
    symbol
    net_position
    trades(order_by: [{ id: desc }], limit: 2) { id quantity price }
  }
  trades { id quantity positions { symbol net_position } }
}
```

- **To one row:** `trades.positions: positions`, null when no position matches.
- **To many rows:** `positions.trades(where, order_by, limit, offset): [trades!]!`, with the arguments applied per position, and `[]` for a position with none.
- **Any depth,** including many rows under one row: a trade's position's trades.
- **Aliases** of one relationship merge when their arguments match; different arguments are refused, for now: "'trades' is selected twice with different arguments; select it once".

A Hasura query that uses relationships runs unchanged.

### Subscriptions: every level is a list of updates

```graphql
subscription {
  positions {
    operation
    fields
    data { instrument_id symbol net_position }
    trades(order_by: [{ id: desc }], limit: 2) {
      operation
      fields
      data { id quantity price }
    }
  }
}
```

A relationship to many rows is a field of the update type, beside `data`: `positions_update.trades(where, order_by, limit, offset): [trades_update!]!`. A relationship to one row is a field inside `data`, as a column is: when any of its selected columns changes, `fields` names it, and `data` sends it whole.

One timestamp's message, here a new AAPL trade that pushes the oldest out of the latest 2:

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

- **A child always arrives under its parent,** which the client has, or gets in the same message.
- **A parent's INSERT carries its children's INSERTs,** so the snapshot is the whole tree; **its DELETE carries their DELETEs;** its UPDATE carries their changes at that timestamp.
- **A parent whose children changed, but not itself,** arrives as an UPDATE of its key alone: `{ "operation": "UPDATE", "fields": ["instrument_id"], "data": { "instrument_id": 1 }, "trades": [...] }`.
- **A child is known within its parent.** A trade moved from GOOG to AAPL arrives as a DELETE under GOOG and an INSERT under AAPL, in either order.
- **An empty list** means nothing changed under an UPDATE, and no children under an INSERT.
- **Updates are unordered,** as now; `order_by`, `limit` and `offset` choose the rows, per parent.
- **`data` keeps the query's row type,** so `data { trades { … } }` is valid GraphQL; in a subscription it's refused: "Subscriptions select 'trades' beside 'data', not inside it".

## The layers

```
client ─GraphQL─▶ API ─Selection─▶ view ─▶ database ─SQL─▶ Materialize
client ◀─JSON──── API ◀─flat changes── view ◀─ database ◀─rows─
```

| Layer | Its job | Files |
|---|---|---|
| API | Reads the GraphQL operation into a `Selection`; builds the response from flat changes: a query's rows, a subscription's updates | `api.resolver.ts`, `schema.ts`, `tree.ts`, `api.service.ts` |
| View | Passes through, for now; a cache or permissions would work on the `Selection` here | `view.service.ts` |
| Database | Builds the statement, runs it, unpacks its rows, pairs each timestamp's rows into changes | `statement.ts`, `filter.ts`, `postgres.ts`, `materialize.ts`, `stream.ts` |

The API never sees SQL, and the database layer never builds a tree.

**A tree goes down, flat changes come up,** as SQL takes a nested question and gives flat rows. Each change's path says which part of the tree it answers.

### Down: the `Selection`

The resolver reads the operation with GraphQL's own field collection (`collectSubFields`: fragments, `@skip`, `@include`) and graphql's `getArgumentValues`:

```json
{
  "columns": ["symbol", "net_position"],
  "orderBy": [{ "symbol": "asc" }],
  "joins": {
    "trades": { "columns": ["id", "quantity", "price"], "orderBy": [{ "id": "desc" }], "limit": 2, "joins": {} }
  }
}
```

A subscription's selection is read from its update type: `data` as a query's row, without relationships to many rows, and each such relationship beside `data` as an update type of its own. Either way it's the same `Selection`.

### Up: flat changes

One complete timestamp at a time, a snapshot's as one timestamp of inserts:

```ts
interface RowUpdateEvent {
  type: RowUpdateType; // INSERT, UPDATE or DELETE
  path: string[];      // [] for a position, ["trades"] for one of its trades
  keys: unknown[];     // [1] for position 1, [1, 8] for its trade 8
  fields: Set<string>; // INSERT: every column; UPDATE: the key and the changed columns; DELETE: the key
  row: Row;            // its own columns, flat: a related row's named by its path, as positions.symbol
}
```

What both layers rely on, stated once, on the type:

- `keys` holds the selected row's key, then one key per relationship to many rows on the path; a relationship to one row adds none.
- A timestamp has at most one change per path and keys.
- A query's changes come in the selection's order, and each source's rows in order under their parent.
- A row's columns are named from the row itself: a trade's own `id`, and its position's `positions.symbol`.
- A related row whose columns are all null matched nothing, as its key is always selected.

## The statement

`new Statement(source, selection, mode)` plans the selection, builds one SQL statement, and unpacks its rows. Every statement is built the same way.

**Planning.** The statement reads each selected source as rows of its own: the selected rows, and each source reached through a relationship to many rows, at any depth, each at its path. A relationship to one row is a `LEFT JOIN` within its row's source, with its columns named by path.

**Building.** One CTE per selected source:

- the selected rows, filtered, ordered, limited and offset;
- each relationship to many rows, read `LATERAL` for each row of its parent, with its own filter, order, limit and offset, per parent, carrying its parent's keys.

The CTEs keep typed columns, for the joins. Each row comes out of a `UNION ALL` of the CTEs as four columns: its source's number, its keys and its own columns, as JSON, and, in a query, its row number. Each value goes into the JSON as the text the database would send for it, and is parsed back by the same parsers as a column's value now.

```sql
WITH __source_0 AS (                           -- the selected positions
  SELECT instrument_id, symbol, net_position,
         row_number() OVER (ORDER BY symbol) AS __row_number
  FROM positions ORDER BY symbol
),
__source_1 AS (                                -- each position's latest 2 trades
  SELECT __source_0.instrument_id, __rows.*
  FROM __source_0 CROSS JOIN LATERAL (
    SELECT id AS "trades.id", quantity AS "trades.quantity", price AS "trades.price",
           row_number() OVER (ORDER BY id DESC) AS __row_number
    FROM trades
    WHERE trades.instrument_id = __source_0.instrument_id
    ORDER BY id DESC LIMIT $1                  -- 2
  ) AS __rows
)
SELECT 0 AS __source, __row_number,
       jsonb_build_array(instrument_id::text) AS __keys,
       jsonb_build_object('instrument_id', instrument_id::text, 'symbol', symbol::text,
                          'net_position', net_position::text) AS __row
FROM __source_0
UNION ALL
SELECT 1, __row_number,
       jsonb_build_array(instrument_id::text, "trades.id"::text),
       jsonb_build_object('id', "trades.id"::text, 'quantity', "trades.quantity"::text,
                          'price', "trades.price"::text)
FROM __source_1
ORDER BY __row_number
```

| `__source` | `__row_number` | `__keys` | `__row` |
|---|---|---|---|
| 0 | 1 | `["1"]` | `{"instrument_id": "1", "symbol": "AAPL", "net_position": "600"}` |
| 1 | 1 | `["1", "8"]` | `{"id": "8", "quantity": "100", "price": "201"}` |
| 0 | 2 | `["2"]` | `{"instrument_id": "2", "symbol": "GOOG", "net_position": "0"}` |
| 1 | 2 | `["1", "7"]` | `{"id": "7", "quantity": "500", "price": "198.4"}` |

- **The JSON is built in the `UNION ALL`,** from the CTEs' typed columns, never in a `SELECT` with a `LIMIT`. Built there, Materialize would hold the JSON, not the values, under the limit: 2.8 times the memory, measured.
- **Each row is tagged with its source's number in the plan,** `__source`, as its CTE is named: 0 for the selected positions, 1 for their trades. Unpacking turns it into the row's path.
- **A query is ordered by row number alone.** Each source's rows come in order under each parent, and the API puts each row under its parent by its keys, wherever it comes.
- **A subscription** runs the same statement, without row numbers, which would renumber a source's rows at every insert. A query's result and a subscription's snapshot are the same rows by construction.
- **The names the statement adds,** `__source`, `__source_0`, `__rows`, `__keys`, `__row` and `__row_number`, start with `__`, which GraphQL reserves, so none can be a source's, a column's or a path's. A path's fields are joined by `.`, which no GraphQL name contains.

**Unpacking.** `statement.unpack(row)` reads one row: its path, from its source's number, and each key and value parsed from its text by the type `schema.yaml` gives its column.

**Pairing,** one complete timestamp at a time:

1. Group the rows by path and keys.
2. Where a group has more than one row, net identical rows: a −1 and a +1 of the same values cancel.
3. Then a +1 alone is an INSERT, a −1 alone a DELETE, a −1 and a +1 an UPDATE of the columns that differ, and nothing left is no change. Anything else is a `KeyViolationError`, naming the key by its path, as `trades.id`.

A query's rows are all +1, so they become inserts; two rows with one key fail the query, as they fail a subscription now.

## Building the response

`tree.ts`, in the API, from one timestamp's flat changes:

1. **Each change goes under its parent's:** the change with its keys less its last, at its path up to the relationship to many rows before its own. The sources' relationships say which fields on a path reach one row and which many.
2. **A parent with no change of its own** gets an UPDATE of its key alone, which goes under its own parent in turn.
3. **Related rows are folded into objects,** null when nothing matched.
4. **A query's** children go into their parent's row, or into the related row they're under, unless it's null. **A subscription's** go beside `data`, by their field.

Each relationship to many rows has a resolver that gives `[]` when a row or update has none, so no message can break GraphQL's non-null list.

`toRows(source, changes)` gives a query's answer; `toUpdates(source, changes)` a subscription's message.

## Evidence

Measured on Materialize v26.49 (10 Nov):

- `SUBSCRIBE` takes the statement: CTEs, a `LATERAL` top 2 per parent, `UNION ALL`.
- A price tick sends only the position's row; its trades' rows carry only its key, so they don't change.
- A new trade sends the position's change, the new trade and the trade it pushed out of the top 2, at one timestamp.
- A position entering or leaving the top N, or closing, brings or takes its trades' rows at the same timestamp.
- A change to a column that isn't selected sends nothing.
- Values as text inside JSON, parsed by tycostream's parsers, match every served type, nulls and extremes included, except that `char(n)` loses its trailing padding, as Postgres's own cast to text does.
- Native JSON values fail: a float of `1e39` or more, or infinite, raises an error; timestamps aren't ISO.
- JSON built in the `UNION ALL` leaves Materialize's arrangements as they are with typed rows. `jsonb_build_object` takes 200 columns; jsonb `||` works.
- Planning a statement with 20 relationships to many rows took 80 ms, for 114 KB of SQL, with typed rows padded with nulls, against 39 ms and 17 KB with the first JSON prototype. Typed rows list every source's columns in every branch of the `UNION ALL`; JSON rows list each source's own. This design's SQL isn't measured yet.
- Each per-parent `limit` keeps about 8 staged copies of its source's rows, per subscription.

Not measured: performance at positions-app's scale, and what Materialize keeps per subscription in all.

## Not chosen

- **Full JSON built in Materialize,** as Hasura does: Materialize can't update a list's JSON in place, so any change rebuilds it, and `SUBSCRIBE` sends it twice, old and new. With three relationships, a price tick sent 22 KB; a new trade among 5,000 sent 1.57 MB. Measured.
- **Typed rows padded with nulls,** every source's columns in every row: rows and SQL grow with every relationship, and it isn't how databases return rows of different shapes; JSON is.
- **The tree built in the database layer:** the GraphQL format's rules would live below the API, and a cache in the view layer would have to undo them.
- **The view layer building the statement:** SQL above the database layer.
- **One `SUBSCRIBE` per source, merged by timestamp:** a connection each, and progress to merge. One statement gets one timestamp for free.
- **One flat join:** a position's change repeats for each of its trades, and two relationships to many rows multiply.
- **Relationships to one row read as sources of their own:** a trade with six would be seven rows rather than one, and a related row's changes would need turning back into a field of the trade.
- **`type: object` or `type: array` in `schema.yaml`:** those describe the API; the file describes the database.

## Later

- **Restore Materialize's index fast path** for queries without relationships: building every statement the same way gives it up, as numbering rows does.
- **Filtering by relationships** (`EXISTS`), and ordering by a related row's columns.
- **Aggregates** (`trades_aggregate`).
- **One relationship selected twice with different arguments,** under two aliases.
- **Exposing a source under another name.**
- **Materialize's `LIMIT INPUT GROUP SIZE` hint,** against the memory each `limit` keeps.
- **Check `schema.yaml`'s types against the database's at startup.** Values are parsed by the types `schema.yaml` declares, not the ones the database reports, so a column declared `int4` that's really `numeric` would turn `1.5` into `1`. The generator writes the right types; a hand edit could get them wrong.

## Open questions

- **Depth:** no cap, unless measuring says so.
- **positions-app's trades:** all of them, or the latest few per position.

## Steps

One branch and one pull request. Each step is one commit, passes every test, and adds only what it needs. Each layer is built once, with both kinds of relationship together:

1. **`filter.ts`:** the `where` conditions move out of `select.ts`. A pure move.
2. **`Statement`:** `buildSelect` becomes `new Statement(source, selection, mode)`, and the adapter and stream take the statement alone. No change for clients.
3. **JSON rows, for one source,** in three commits:
   - **3a:** `statement.unpack(row)` reads the statement's rows back, so the adapters don't pick columns themselves.
   - **3b:** every statement is built the same way: the source's rows as a CTE, and a query ordered by `__row_number`. Queries lose the index fast path.
   - **3c:** each row comes back as one JSON object, `__row`, of its values as text, which `unpack` parses by type. `char(n)` loses its padding. Tests: every served type through the JSON.
4. **Foreign keys:** `foreign_keys` in `schema.yaml`, both relationships derived from each, and the startup checks. Not in the API yet.
5. **`tree.ts`:** building a query's rows and a subscription's updates moves out of `ApiService`, into `toRows` and `toUpdates`. No change for clients.
6. **The statement reads related rows of both kinds:** a relationship to one row as a `LEFT JOIN`, its columns named by path in the row's JSON; one to many rows as a CTE, read `LATERAL` for each parent row and tagged `__source`. Unit-tested, not yet reachable from GraphQL. If its diff is too big, it splits by mechanism: the joins, then the CTEs.
7. **Changes carry `path` and `keys`,** paired the same way for queries and subscriptions, in the database layer; the statement adds `__keys`. A key that isn't unique now fails a query too.
8. **Relationships in queries, both kinds:** their fields and arguments, the resolver reading nested selections, `tree.ts` folding related rows into objects and nesting lists, and `[]` from the resolvers. Useful on its own: Hasura's nested queries, in one consistent read.
9. **Relationships in subscriptions, both kinds:** the goal. Related rows inside `data`, lists beside it as the update types' fields, reading a subscription's selection, the key-only UPDATE, and the refusal inside `data`. Tests, a rule each: the snapshot as a tree; a price tick; a new trade; a trade's price corrected (the key-only UPDATE); two relationships under a key-only UPDATE; a trade pushed out of `limit: 2`; a position closed (its DELETE with its trades' DELETEs); a trade moved between positions; two levels; a related row's column changing (its field in `fields`, sent whole). End to end, against Materialize: the same, plus a position entering and leaving the top N, aliases, and the refusals.
10. **The README.**

Then positions-app moves to one subscription, against a local build until a release. Immer's `produce` could apply each message's nested updates to its React state, changing only the positions and trades that changed, so only their rows re-render.

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
12. https://github.com/hasura/graphql-engine/blob/master/server/src-lib/Hasura/GraphQL/Execute/RemoteJoin/Join.hs
