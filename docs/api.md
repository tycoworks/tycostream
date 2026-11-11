# GraphQL API

tycostream gives each source in `schema.yaml` a query and a subscription, both named after the source, and both taking the same arguments. A query returns the rows as they are now, and a subscription returns them and then every change, over server-sent events. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app).

## Queries and subscriptions

For the positions-app example, tycostream generates:

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

Each column in `schema.yaml` is a field of the source's type, and the primary key is the only one that's non-null.

## Updates

A subscription first sends a snapshot of `INSERT` messages, and then a stream of `INSERT`, `UPDATE`, and `DELETE` messages. Each message is a list of updates holding every change at one Materialize timestamp, so all of a transaction's changes arrive in the same message. Messages arrive in timestamp order, and the updates within a message in no particular order, whatever the subscription's `order_by`.

`fields` lists the columns an update sends, and the other columns in `data` are `null`. It always names the key, but `data` holds the key only if you select it.

- An `INSERT` sends the key and every selected column.
- An `UPDATE` sends the key and the selected columns that changed. A change to a column you didn't select sends nothing.
- A `DELETE` sends only the key.

A row that starts or stops matching `where` arrives as an `INSERT` or a `DELETE`. So does a row that moves in or out of the rows that `order_by` picks with `limit` or `offset`. For the positions-app example, with `order_by: [{ market_value: desc }], limit: 2`, a position that moves into the top two arrives as an `INSERT`, and one that drops out as a `DELETE`.

## Filters

`where` takes the same format as Hasura's. For the positions-app example, to get the GOOG position and any position over 30,000 shares:

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

Every column takes the first four rows of operators, and text columns (`text`, `varchar`, and `bpchar`) take the rest:

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

Comparisons side by side in one object must all match. `_and` and `_or` take a list of conditions, and `_not` takes one. A null column matches only `_is_null`, as in SQL, and comparing a column with `null` is refused. An enum column compares in the order of the enum's values in `schema.yaml`. `int8` and `numeric` arguments take a number or a string, and a string keeps every digit.

## Sorting and paging

`order_by` takes a list of columns, each with a direction, and applies them in turn. The directions are `asc`, `desc`, `asc_nulls_first`, `asc_nulls_last`, `desc_nulls_first`, and `desc_nulls_last`. `limit` caps the number of rows, and `offset` skips that many first.

For the positions-app example, to get the two largest positions:

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
| `bpchar` | `bpchar` | `"ab "`, padded to the column's length |
| `bool` | `Boolean` | `true` |
| `uuid` | `uuid` | `"a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"` |
| `timestamp` | `timestamp` | `"2026-01-01T09:30:00.5"` |
| `timestamptz` | `timestamptz` | `"2026-01-01T07:30:00+00:00"`, in UTC |
| `date` | `date` | `"2026-01-02"` |
| `time` | `time` | `"09:30:00"` |
| `interval` | `interval` | `"1 day 02:03:04"` |
| `json`, `jsonb` | `json`, `jsonb` | `{"side": "buy"}` |
| `bytea` | `bytea` | `"\\x0102"`, in hex |

An enum in `schema.yaml` becomes a GraphQL enum of the same name, and its values arrive as strings.
