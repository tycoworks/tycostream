# How to set up tycostream

This guide shows you how to serve the views in your streaming database as a GraphQL API. You'll describe the views in a `schema.yaml` file, run tycostream against your database, and then query and subscribe from a GraphQL client. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app), which holds a trading desk's live positions.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. tycostream supports [Materialize](https://materialize.com/) today.
- **Docker**, or another tool that runs container images.
- **psql**, if you use the schema generator.

## Step 1: Describe your views

First, create a `schema.yaml` file, which tells tycostream which tables and views to serve through your API. You can write it by hand, or use the [schema generator](../scripts/generate-schema.sh) to read their columns from your database.

The generator needs the name of each table or view, and its primary key, the column that's different in every row. This command describes positions-app's `positions` view, keyed by `instrument_id`:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

The generator connects to `localhost:6875` as `materialize`, Materialize's defaults, unless you set the `DATABASE_*` settings in your environment or a `.env` file. The file it writes lists each column with its Postgres type, such as `int8` or `numeric`. The [configuration reference](configuration.md) covers the rest of the format, including enums.

Whichever way you make the file, tycostream holds it to three rules. Names must match the database exactly, including case. A primary key must be different in every row the view returns, or subscriptions to the view end with an error. And every column's type must be one tycostream supports, or it stops at startup and lists the types it does.

## Step 2: Run tycostream

Next, start tycostream, which connects to your database and serves an API for the views in your `schema.yaml`. Run its Docker image with any settings that differ from the defaults.

This command reaches a database on your own machine, and turns on the GraphQL explorer:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

Once tycostream logs that it's ready, your API is at `http://localhost:4000/graphql`. To reach a database elsewhere, set `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, and the other settings in the configuration reference. Each subscription runs in the database as its own query, so index the views you serve, or make them materialized views, or the database works each one out again for every client.

tycostream holds a database connection open for each subscription, and lends one to each query while it runs. Once `DATABASE_MAX_CONNECTIONS` are in use, 1,000 by default, a new subscription or query waits up to 10 seconds for one to come free, then fails. A query also fails if it runs longer than `DATABASE_QUERY_TIMEOUT_MS`, 30 seconds by default.

## Step 3: Query and subscribe

Finally, read your views through the API. A query returns the rows as they are now, and a subscription returns them and then every change. Try both in the GraphQL explorer at `http://localhost:4000/graphql`, then connect your app with a GraphQL client.

Here's a query for every position, sorted by symbol:

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

A subscription takes the same arguments. Each message it sends is a list of updates from one transaction, and the first message holds the current rows:

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

An update's `fields` names the key and the columns that changed, and the other columns in `data` are `null`. A column whose new value is null is still named in `fields`, so a client applies each update by its `fields`, not by its nulls. An `INSERT` names the key and every column you selected, and a `DELETE` names only the key.

Updates come in no particular order, even within one message. `order_by`, `limit`, and `offset` choose which rows a subscription covers, so sort them in the client if order matters. A row that moves into those rows arrives as an `INSERT`, and one that moves out as a `DELETE`, so the client never holds more rows than it asked for. A change to a column you didn't select sends nothing.

To subscribe from an app, use a GraphQL client that speaks server-sent events, such as Apollo Client with Yoga's [Apollo link](https://github.com/graphql-hive/graphql-yoga/tree/main/packages/client/apollo-link). positions-app's [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js) sets one up and subscribes in about 20 lines. The [API reference](api.md) lists every filter operator, and how each type arrives in JSON.

## Current limitations

- A primary key is one column.
- `bigint` and `numeric` arrive as JSON numbers, so a value with more than about 15 significant digits loses its last ones.
- If a subscription's database connection drops, the subscription ends with an error, and the client subscribes again.
- Array columns aren't served yet.
- Related rows, such as a position's trades, need their own subscription until [relationships](https://github.com/tycoworks/tycostream/issues/2) land.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
