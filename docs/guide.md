# How to set up tycostream

This guide shows you how to serve the views in your streaming database as a GraphQL API. You'll describe the views in a `schema.yaml` file, run tycostream against your database, and then query and subscribe from a GraphQL client, so your app gets every change to a view as it happens. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app), which holds a trading desk's live positions and which you can run yourself.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. tycostream supports [Materialize](https://materialize.com/) today.
- **Docker**, or another tool that runs container images.
- **psql**, if you use the schema generator.

## Step 1: Describe your views

First, create a `schema.yaml` file, which tells tycostream which tables and views to serve through your API. You can write it by hand, or use the [schema generator](../scripts/generate-schema.sh) to read their columns from your database.

For the positions-app example, to describe its `positions` view, keyed by `instrument_id`:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

Add `-s` and `-p` again for each other table or view you want to serve. By default, the generator connects to Materialize on `localhost:6875`. To reach another database, set the `DATABASE_*` settings from step 2 in your environment or a `.env` file.

positions-app's [`schema.yaml`](https://github.com/tycoworks/positions-app/blob/main/schema.yaml) is a complete file. It lists each view under `sources`, with its `primary_key` and its `columns`, and gives each column a Postgres type. Names must match the database exactly, and each primary key must be unique. If a column's type isn't supported, tycostream names it, and lists the types it supports, when it starts.

To serve a text column as a GraphQL enum, name the enum and its values with `-e`, then map the column to it with `-c`, after its view's `-s`. For a `side` column in a `trades` view, that's `-e trade_side "buy,sell" -s trades -p id -c side:trade_side`.

## Step 2: Run tycostream

Next, start tycostream's Docker image, `ghcr.io/tycoworks/tycostream`, with your `schema.yaml` and your database's connection settings. Mount the file at `/app/schema.yaml`, and pass the settings as environment variables.

For the positions-app example, with Materialize running on your own machine:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

When the log shows `=== tycostream ready ===`, your API is at `http://localhost:4000/graphql`. Set any of these settings with `-e`, or put them in a file and pass it with `--env-file`:

| Setting | Default | What it sets |
|---|---|---|
| `DATABASE_HOST` | `localhost` | The database's host. Inside Docker, `host.docker.internal` reaches your own machine. |
| `DATABASE_PORT` | `6875` | The database's port |
| `DATABASE_USER` | `materialize` | The user tycostream connects as |
| `DATABASE_PASSWORD` | `materialize` | That user's password |
| `DATABASE_NAME` | `materialize` | The database to connect to |
| `DATABASE_MAX_CONNECTIONS` | `1000` | How many database connections tycostream can open. Each subscription holds one, and each query borrows one. Past the limit, a new one waits up to 10 seconds, then fails. |
| `DATABASE_QUERY_TIMEOUT_MS` | `30000` | How long a query can run before it fails, in milliseconds |
| `GRAPHQL_PORT` | `4000` | The port tycostream serves the API on |
| `GRAPHQL_UI` | `false` | Whether to serve the GraphQL explorer at `/graphql` |
| `SCHEMA_PATH` | `/app/schema.yaml` | Where tycostream reads `schema.yaml` |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, or `error` |

## Step 3: Query and subscribe

Finally, use a query to get the rows as they are now, or a subscription to get them and then every change. Try both in the GraphQL explorer, then connect your app with a GraphQL client that supports subscriptions over server-sent events, such as Apollo Client with Yoga's [Apollo link](https://github.com/graphql-hive/graphql-yoga/tree/main/packages/client/apollo-link).

For the positions-app example, to get every position, sorted by symbol:

```graphql
{
  positions(order_by: { symbol: asc }) {
    instrument_id
    symbol
    net_position
    latest_price
    market_value
  }
}
```

```json
{
  "positions": [
    { "instrument_id": 1, "symbol": "AAPL", "net_position": 19410, "latest_price": 200.09, "market_value": 3883746.9 },
    { "instrument_id": 2, "symbol": "GOOG", "net_position": 14900, "latest_price": 183.39, "market_value": 2732511 },
    { "instrument_id": 3, "symbol": "MSFT", "net_position": 16090, "latest_price": 444.43, "market_value": 7150878.7 }
  ]
}
```

And to follow the AAPL position as it changes:

```graphql
subscription {
  positions(where: { symbol: { _eq: "AAPL" } }) {
    operation
    data { instrument_id symbol net_position latest_price market_value }
    fields
  }
}
```

```json
[{ "operation": "INSERT",
   "data": { "instrument_id": 1, "symbol": "AAPL", "net_position": 19410, "latest_price": 200.48, "market_value": 3891316.8 },
   "fields": ["instrument_id", "symbol", "net_position", "latest_price", "market_value"] }]

[{ "operation": "UPDATE",
   "data": { "instrument_id": 1, "symbol": null, "net_position": null, "latest_price": 200.77, "market_value": 3896945.7 },
   "fields": ["instrument_id", "latest_price", "market_value"] }]
```

To keep a copy of the rows in your app, select the key, and apply each message's updates by it. The first message holds the current rows, and every later one holds one transaction's changes, so apply each message whole and your copy never shows half a transaction. An `UPDATE` holds only the columns listed in `fields`, and the others come as `null`, so copy just those onto the row you have. A `DELETE` holds only the key, and a change to a column you didn't select sends nothing.

To show the rows in order, sort them in your app, since a subscription's updates arrive in no particular order, whatever its `order_by`. With `limit`, `order_by` picks a set, such as the two largest positions (`order_by: { market_value: desc }, limit: 2`), and a row that enters or leaves that set arrives as an `INSERT` or a `DELETE`.

positions-app's [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js) sets up a client and subscribes in about 20 lines. Filters, sorting, and paging work as they do in Hasura, and the [API reference](api.md) lists every operator, the supported types, and how each arrives in JSON.

## Current limitations

- There's no authentication yet, so anyone who can reach tycostream's port can read every view in `schema.yaml`.
- Each view needs a single-column primary key.
- `int8` and `numeric` values arrive as JSON numbers, so a value with more than about 15 significant digits loses its last ones.
- If a subscription's database connection drops, the subscription ends with an error. Subscribe again, and replace your copy with the current rows that arrive first.
- tycostream doesn't serve array columns yet.
- Related rows, such as a position's trades, need their own subscription until [relationships](https://github.com/tycoworks/tycostream/issues/2) land.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
