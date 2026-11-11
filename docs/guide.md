# How to serve streaming database views as a real-time GraphQL API

This guide shows you how to serve the views in your streaming database to apps as GraphQL queries and subscriptions. You'll describe the views in a `schema.yaml`, run tycostream against your database, and then query and subscribe from a GraphQL client. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app), which holds a trading desk's live positions.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. Each needs a primary key, a column whose value is different in every row. tycostream supports [Materialize](https://materialize.com/) today.
- **[Docker](https://docs.docker.com/get-started/get-docker/)**, to run tycostream.
- **psql**, which the schema generator uses to read your views' columns.

## Step 1: Describe your views

List the tables and views you want to serve in a `schema.yaml`, with each one's primary key. The [schema generator](../scripts/generate-schema.sh) reads their columns from your database, so you only name the views and their keys:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

The generator connects to `localhost:6875` as `materialize`, Materialize's defaults, unless you set the `DATABASE_*` settings in your environment or a `.env` file. You get a `schema.yaml` with each view's columns and their Postgres types, such as `int8` and `numeric`. To serve a text column as a GraphQL enum, name the enum's values and the column (`-e side "buy,sell" -c side:side`), and see the [configuration reference](configuration.md) for the whole format.

## Step 2: Run tycostream

Start the Docker image with your `schema.yaml` and the settings that differ from the defaults. This command reaches a database on your own machine and turns on the GraphQL explorer:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

Once tycostream logs that it's ready, it serves your API at `http://localhost:4000/graphql`. To reach a database elsewhere, set `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, and the other settings in the configuration reference. Each subscription runs in the database as its own query, so index the views you serve, or make them materialized views, or the database works each one out again for every client.

## Step 3: Query and subscribe

Open `http://localhost:4000/graphql` in a browser to try your API. A query returns the rows as they are now:

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

A subscription takes the same arguments, and sends the rows and then every change to them. Each message is a list of updates from one transaction, and the first message holds the current rows:

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

To subscribe from an app, use a GraphQL client that speaks server-sent events, such as Apollo Client with Yoga's [Apollo link](https://github.com/graphql-hive/graphql-yoga/tree/main/packages/client/apollo-link). positions-app's [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js) sets one up and subscribes in about 20 lines. The [API reference](api.md) lists every filter operator, and how each type arrives in JSON.

## Current limitations

- A primary key is one column.
- Each subscription holds its own database connection, up to `DATABASE_MAX_CONNECTIONS` (1,000 by default).
- If a subscription's database connection drops, the subscription ends with an error, and the client subscribes again.
- Array columns aren't served yet.
- Related rows, such as a position's trades, need their own subscription until [relationships](https://github.com/tycoworks/tycostream/issues/2) land.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
