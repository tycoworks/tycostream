# How to set up tycostream

This guide shows you how to serve the views in your streaming database as a GraphQL API. You'll describe the views in a `schema.yaml` file, run tycostream against your database, and then query and subscribe from a GraphQL client. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app), which holds a trading desk's live positions.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. tycostream supports [Materialize](https://materialize.com/) today.
- **Docker**, or another tool that runs container images.
- **psql**, if you use the schema generator.

## Step 1: Describe your views

First, create a `schema.yaml` file, which tells tycostream which tables and views to serve through your API. You can write it by hand, or use the [schema generator](../scripts/generate-schema.sh) to read their columns from your database.

To describe positions-app's `positions` view, keyed by `instrument_id`:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

The generator connects to `localhost:6875` as `materialize` unless you set the `DATABASE_*` settings in your environment or a `.env` file. The [configuration reference](configuration.md) covers the rest of the format, including enums.

Names must match the database exactly, including case. A view whose primary key repeats ends its subscriptions with an error. A column type tycostream doesn't support stops it at startup, with a list of the types it does.

## Step 2: Run tycostream

Next, start tycostream, which connects to your database and serves an API for the views in your `schema.yaml`. Run its Docker image with any settings that differ from the defaults.

To reach a database on your own machine, with the GraphQL explorer on:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

Once tycostream logs that it's ready, your API is at `http://localhost:4000/graphql`. To reach a database elsewhere, set `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, and the other settings in the configuration reference. Each subscription runs in the database as its own query, so index the views you serve, or make them materialized views, or the database recomputes them for every client.

tycostream holds a database connection open for each subscription, and lends one to each query while it runs. Once `DATABASE_MAX_CONNECTIONS` are in use, 1,000 by default, a new subscription or query waits up to 10 seconds for one to come free, then fails. A query also fails if it runs longer than `DATABASE_QUERY_TIMEOUT_MS`, 30 seconds by default.

## Step 3: Query and subscribe

Finally, read your views through the API. A query returns the rows as they are now, and a subscription returns them and then every change. Try both in the GraphQL explorer at `http://localhost:4000/graphql`, then connect your app with a GraphQL client.

To get every position, sorted by symbol:

```graphql
{
  positions(order_by: { symbol: asc }) {
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
    { "symbol": "AAPL", "net_position": 10220, "latest_price": 188.29, "market_value": 1924323.8 },
    { "symbol": "GOOG", "net_position": 8250, "latest_price": 188.99, "market_value": 1559167.5 },
    { "symbol": "MSFT", "net_position": 10060, "latest_price": 459.07, "market_value": 4618244.2 }
  ]
}
```

To follow the AAPL position as it changes:

```graphql
subscription {
  positions(where: { symbol: { _eq: "AAPL" } }) {
    operation
    data { symbol net_position latest_price market_value }
    fields
  }
}
```

```json
[{ "operation": "INSERT",
   "data": { "symbol": "AAPL", "net_position": 10230, "latest_price": 188.25, "market_value": 1925797.5 },
   "fields": ["instrument_id", "symbol", "net_position", "latest_price", "market_value"] }]

[{ "operation": "UPDATE",
   "data": { "symbol": null, "net_position": null, "latest_price": 188.4, "market_value": 1927332 },
   "fields": ["instrument_id", "latest_price", "market_value"] }]
```

Each message is one transaction's updates, and the first holds the current rows. `fields` names the key, with every selected column for an `INSERT`, the changed columns for an `UPDATE`, and nothing more for a `DELETE`. Columns it doesn't name are `null` in `data`, so apply each update by its `fields`.

Updates come in no particular order, even within one message, so sort them in the client if order matters. `order_by`, `limit`, and `offset` choose which rows a subscription covers, and a row that moves in or out of them arrives as an `INSERT` or a `DELETE`. A change to a column you didn't select sends nothing.

To subscribe from an app, use a GraphQL client that speaks server-sent events, such as Apollo Client with Yoga's [Apollo link](https://github.com/graphql-hive/graphql-yoga/tree/main/packages/client/apollo-link). positions-app's [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js) sets one up and subscribes in about 20 lines. The [API reference](api.md) lists every filter operator, and how each type arrives in JSON.

## Current limitations

- A primary key is one column.
- `bigint` and `numeric` arrive as JSON numbers, so a value with more than about 15 significant digits loses its last ones.
- If a subscription's database connection drops, the subscription ends with an error, and the client subscribes again.
- Array columns aren't served yet.
- Related rows, such as a position's trades, need their own subscription until [relationships](https://github.com/tycoworks/tycostream/issues/2) land.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
