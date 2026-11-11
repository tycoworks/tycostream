# How to set up tycostream

This guide shows you how to serve your streaming database's views as a GraphQL API. You describe the views in `schema.yaml`, run tycostream, then query and subscribe from any GraphQL client. The examples use the `positions` and `trades` views from [positions-app](https://github.com/tycoworks/positions-app), an example trading app you can run yourself: a trading desk's live positions, and their trades.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. tycostream supports [Materialize](https://materialize.com/) today.
- **Docker**, or another tool that runs container images.
- **psql**, if you use the schema generator.

## Step 1: Describe your views

First, create a `schema.yaml` that lists the tables and views to serve. Write it by hand, or generate it from your database with the [schema generator](../scripts/generate-schema.sh).

The file has two parts:

- **`sources`** lists each table or view, with its `primary_key` and its `columns`, each of a supported Postgres [type](api.md#types). Names must match the database exactly, and each primary key must be unique. An unsupported type stops tycostream at startup, with a list of the supported ones.
- **`enums`** is an optional list of each GraphQL enum's values. To serve a text column as an enum, set the column's type to the enum's name.

To describe relationships between two sources, add `foreign_keys` to the one that references the other. For example, each trade's `instrument_id` holds its position's key:

```yaml
sources:
  trades:
    primary_key: id
    columns: { ... }
    foreign_keys:
      instrument_id: positions
```

A foreign key relates both ways, so each trade has a position, and each position has trades.

positions-app's [`schema.yaml`](https://github.com/tycoworks/positions-app/blob/main/schema.yaml) is a complete example.

To generate the file for positions-app:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

Add `-s` and `-p` for each other table or view. For an enum column, declare the enum with `-e` and map the column with `-c column:enum` after its view: `-e trade_side "buy,sell" -s trades -p id -c side:trade_side`. For a foreign key, add `-f column:source` after its view: `-s trades -p id -f instrument_id:positions`.

The generator connects to `localhost:6875` by default. For another database, set the `DATABASE_*` settings from step 2 in your environment or a `.env` file.

## Step 2: Run tycostream

Next, start tycostream's Docker image, `ghcr.io/tycoworks/tycostream`, with your `schema.yaml` and your database's connection settings. Mount the file at `/app/schema.yaml`, and pass the settings with `-e` or `--env-file`.

For example, with Materialize running on your own machine:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

When the log shows `=== tycostream ready ===`, your API is at `http://localhost:4000/graphql`.

tycostream takes these settings:

| Setting | Default | What it sets |
|---|---|---|
| `DATABASE_HOST` | `localhost` | The database's host. Inside Docker, `host.docker.internal` reaches your own machine. |
| `DATABASE_PORT` | `6875` | The database's port |
| `DATABASE_USER` | `materialize` | The user tycostream connects as |
| `DATABASE_PASSWORD` | `materialize` | That user's password |
| `DATABASE_NAME` | `materialize` | The database to connect to |
| `DATABASE_MAX_CONNECTIONS` | `1000` | How many database connections tycostream can open. Each subscription holds one, and each query borrows one. Past the limit, a new query or subscription waits up to 10 seconds, then fails. |
| `DATABASE_QUERY_TIMEOUT_MS` | `30000` | How long a query can run before it fails, in milliseconds |
| `GRAPHQL_PORT` | `4000` | The port tycostream serves the API on |
| `GRAPHQL_UI` | `false` | Whether to serve the GraphQL explorer at `/graphql` |
| `SCHEMA_PATH` | `/app/schema.yaml` | Where tycostream reads `schema.yaml` |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, or `error` |

## Step 3: Query and subscribe

Finally, query to get the rows at that moment, or subscribe to get a snapshot, then each change as it happens. Try both in the GraphQL explorer, then from your app.

For example, to get every position, sorted by symbol:

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

After the snapshot, each `UPDATE` sends only the columns that changed, and the rest are `null`. See how positions-app applies them in [`applyUpdates`](https://github.com/tycoworks/positions-app/blob/main/ui/main.js#L34-L57).

You can nest related sources in a query or a subscription, and in a subscription you nest them beside `data`. For example, to follow each position with its trades:

```graphql
subscription {
  positions {
    operation
    data { instrument_id symbol net_position }
    fields
    trades { operation data { id quantity price } fields }
  }
}
```

A new trade then arrives in the same message as the change it makes to its position. For a flat row with both sources' columns, join them in a view and serve that. The API reference covers [nested fields](api.md#queries-and-subscriptions) and their [updates](api.md#updates).

tycostream serves subscriptions over server-sent events, not WebSockets. Apollo Client supports them through Yoga's [Apollo link](https://github.com/graphql-hive/graphql-yoga/tree/main/packages/client/apollo-link), as in positions-app's [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js).

The [API reference](api.md) covers what each update holds, and every filter, sort, and type.

## Current limitations

- There's no [authentication](https://github.com/tycoworks/tycostream/issues/36) yet, so anyone who can reach tycostream's port can read every view in `schema.yaml`.
- There's no setting for an [encrypted connection](https://github.com/tycoworks/tycostream/issues/40) to the database yet.
- There's no [reconnection](https://github.com/tycoworks/tycostream/issues/38) yet, so a subscription ends with an error if its database connection drops.
- Each source in `schema.yaml` needs a single-column primary key.
- `int8` and `numeric` values arrive as JSON numbers, so values past about 15 significant digits lose precision.
- tycostream doesn't serve [array columns](https://github.com/tycoworks/tycostream/issues/33) yet.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
