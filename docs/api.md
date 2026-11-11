# GraphQL API

tycostream generates a GraphQL API from your `schema.yaml`. The examples use the `positions` and `trades` views from [positions-app](https://github.com/tycoworks/positions-app), an example trading app built on tycostream.

## Queries and subscriptions

tycostream creates a query and a subscription for each source in your `schema.yaml`. A query returns the rows at the time of the query, whereas a subscription sends a snapshot, then each change as it happens. For example, tycostream generates:

```graphql
type query_root {
  positions(where: positions_bool_exp, order_by: [positions_order_by!], limit: Int, offset: Int): [positions!]!
}

type subscription_root {
  positions(where: positions_bool_exp, order_by: [positions_order_by!], limit: Int, offset: Int): [positions_update!]!
}

type positions_update {
  operation: row_operation!  # INSERT, UPDATE, or DELETE
  data: positions
  fields: [String!]!
}
```

Each column becomes a field, and only the primary key is non-null.

tycostream creates a nested field on both sources for each foreign key in your `schema.yaml`. For example:

```graphql
type trades {
  positions: positions
}

type positions {
  trades(where: trades_bool_exp, order_by: [trades_order_by!], limit: Int, offset: Int): [trades!]!
}
```

A trade's `positions` is `null` if it has no position, and a position's `trades` is `[]` if it has no trades. A nested list's arguments apply per parent, so `limit: 2` returns up to two trades per position. Nesting can go to any depth. Aliases of one nested field must use the same arguments.

## Updates

A subscription sends a snapshot as `INSERT`s, then each change as an `INSERT`, `UPDATE`, or `DELETE`. Each message holds every change at one Materialize timestamp, so a transaction's changes arrive together. Messages arrive in timestamp order, but the updates within a message are unordered, whatever the `order_by`.

Each update is one row's change. `fields` lists the columns it sends, always including the key, and every other column in `data` is `null`. `data` holds the key only if you select it.

- An `INSERT` sends the key and every selected column.
- An `UPDATE` sends the key and the selected columns that changed. A change to a column you didn't select sends nothing.
- A `DELETE` sends only the key.

A row that enters or leaves the results, through `where`, `limit`, or `offset`, arrives as an `INSERT` or a `DELETE`. For example, with `order_by: [{ market_value: desc }], limit: 2`, a position that moves into the top two arrives as an `INSERT`, and the one it displaces as a `DELETE`.

A nested row, such as a trade's `positions`, counts as one column. If any of its columns change, `fields` names it and `data` sends it whole.

A nested list sits beside `data` and holds its own updates. A position's `INSERT` includes its trades' `INSERT`s, and its `DELETE` their `DELETE`s. If only a position's trades change, the position arrives as an `UPDATE` of its key alone. A trade that moves between positions arrives as a `DELETE` under one and an `INSERT` under the other, in the same message.

## Filters

`where` filters rows, in Hasura's format. For example, to get the GOOG position and any position over 30,000 shares:

```graphql
{
  positions(
    where: { _or: [{ symbol: { _eq: "GOOG" } }, { net_position: { _gt: 30000 } }] }
    order_by: [{ symbol: asc }]
  ) {
    symbol
    net_position
  }
}
```

```json
{
  "positions": [
    { "symbol": "AAPL", "net_position": 30250 },
    { "symbol": "GOOG", "net_position": 24200 }
  ]
}
```

Every column supports the first four rows of operators, and text columns (`text`, `varchar`, and `bpchar`) also support the rest:

| Operator | Matches |
|---|---|
| `_eq`, `_neq` | Equal, or not equal |
| `_gt`, `_gte`, `_lt`, `_lte` | Greater than, at least, less than, or at most |
| `_in`, `_nin` | In a list, or not |
| `_is_null` | Null when `true`, and not null when `false` |
| `_like`, `_nlike` | A SQL `LIKE` pattern, or not |
| `_ilike`, `_nilike` | A `LIKE` pattern ignoring case, or not |
| `_regex`, `_nregex` | A regular expression, or not |
| `_iregex`, `_niregex` | A regular expression ignoring case, or not |

- Comparisons in one object must all match. `_and` and `_or` take a list of conditions, and `_not` takes one.
- A null column matches only `_is_null`, as in SQL. Comparing a column with `null` is refused.
- An enum column compares in its enum's order.
- `int8` and `numeric` arguments take a number or a string, and a string keeps every digit.
- Regular expressions use Rust's syntax, as Materialize's do, not POSIX.

## Sorting and paging

`order_by` sorts rows by a list of columns, each with a direction, applied in turn. The directions are `asc`, `desc`, `asc_nulls_first`, `asc_nulls_last`, `desc_nulls_first`, and `desc_nulls_last`. `limit` caps the number of rows, and `offset` skips that many first.

For example, to get the two largest positions:

```graphql
{
  positions(order_by: [{ market_value: desc }], limit: 2) {
    symbol
    market_value
  }
}
```

```json
{
  "positions": [
    { "symbol": "MSFT", "market_value": 10960638.5 },
    { "symbol": "AAPL", "market_value": 6419350.4 }
  ]
}
```

## Types

tycostream serves each Postgres type as a GraphQL type and JSON value:

| Postgres type | GraphQL type | JSON value |
|---|---|---|
| `int2` | `smallint` | `7` |
| `int4` | `Int` | `7` |
| `int8` | `bigint` | `9007199254740991` |
| `float4` | `Float` | `1.5` |
| `float8` | `float8` | `2.25` |
| `numeric` | `numeric` | `1234.5678` |
| `text`, `varchar` | `String` | `"hello"` |
| `bpchar` | `bpchar` | `"ab"`, without its trailing padding |
| `bool` | `Boolean` | `true` |
| `uuid` | `uuid` | `"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"` |
| `timestamp` | `timestamp` | `"2026-01-01T09:30:00.5"` |
| `timestamptz` | `timestamptz` | `"2026-01-01T07:30:00+00:00"`, in UTC |
| `date` | `date` | `"2026-01-02"` |
| `time` | `time` | `"09:30:00"` |
| `interval` | `interval` | `"1 day 02:03:04"` |
| `json`, `jsonb` | `json`, `jsonb` | `{"side": "buy"}` |
| `bytea` | `bytea` | `"\\x0102"`, in hex |

An enum becomes a GraphQL enum of the same name, and its values arrive as strings.
