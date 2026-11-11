# How to set up tycostream

This guide shows you how to serve the views in your streaming database as a GraphQL API. You'll describe the views in a `schema.yaml` file, run tycostream against your database, and then query and subscribe from a GraphQL client, so your app gets every change to a view as it happens. The examples use the `positions` view from [positions-app](https://github.com/tycoworks/positions-app), which holds a trading desk's live positions and which you can run yourself.

## What you'll need

- **A streaming database**, with the tables or views you want to serve. tycostream supports [Materialize](https://materialize.com/) today.
- **Docker**, or another tool that runs container images.
- **psql**, if you use the schema generator.

## Step 1: Describe your views

First, create a `schema.yaml` file, which tells tycostream which tables and views to serve through your API. You can write it by hand, or use the [schema generator](../scripts/generate-schema.sh) to read their columns from your database.

The file has two parts, and positions-app's [`schema.yaml`](https://github.com/tycoworks/positions-app/blob/main/schema.yaml) is a complete example:

- **`sources`** lists each table or view, with its `primary_key` and its `columns`, and gives each column a Postgres type. Names must match the database exactly, and each primary key must be unique. If tycostream doesn't support a column's type, it says so when it starts, and lists the types it does.
- **`enums`** is optional, and lists the values of each GraphQL enum. To serve a text column as an enum, give it the enum's name as its type.

To generate the file for the positions-app example, with its `positions` view keyed by `instrument_id`:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

Add `-s` and `-p` again for each other table or view. To add an enum, name it and its values with `-e`, and map a column to it with `-c` after its view's `-s`, as in `-e trade_side "buy,sell" -s trades -p id -c side:trade_side`. By default, the generator connects to Materialize on `localhost:6875`, and to reach another database, you set the `DATABASE_*` settings from step 2 in your environment or a `.env` file.

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

After the current rows, a subscription sends only changes to the columns you selected, not whole rows. Each update inserts, updates, or deletes one row, and an `UPDATE` holds just the columns that changed, which `fields` lists, with the others `null`. So your app keeps its own copy of the rows, and applies each update to the row with the same key, which means selecting the key, as the example does with `instrument_id`. Each message holds one whole transaction, so apply a message's updates together, and your copy never shows half a transaction. For the positions-app example, [graphql.js](https://github.com/tycoworks/positions-app/blob/main/ui/graphql.js) sets up the client and subscribes, and [`applyUpdates`](https://github.com/tycoworks/positions-app/blob/main/ui/main.js#L34-L57) applies each message to its grid.

Updates arrive in no particular order, whatever a subscription's `order_by`, so sort the rows in your app to show them in order. `order_by` matters with `limit` and `offset`, where it picks which rows the subscription covers, such as the two largest positions (`order_by: { market_value: desc }, limit: 2`). A row that enters or leaves those rows arrives as an `INSERT` or a `DELETE`.

Filters, sorting, and paging work as they do in Hasura. The [API reference](api.md) lists every operator, the supported types, and how each type arrives in JSON.

## Current limitations

- There's no [authentication](https://github.com/tycoworks/tycostream/issues/36) yet, so anyone who can reach tycostream's port can read every view in `schema.yaml`.
- There's no setting for an [encrypted connection](https://github.com/tycoworks/tycostream/issues/40) to the database yet.
- Each view needs a single-column primary key.
- `int8` and `numeric` values arrive as JSON numbers, so a value with more than about 15 significant digits loses its last ones.
- If a subscription's database connection drops, the subscription ends with an error. Subscribe again, and replace your copy with the current rows that arrive first. [Reconnecting](https://github.com/tycoworks/tycostream/issues/38) is planned.
- tycostream doesn't serve [array columns](https://github.com/tycoworks/tycostream/issues/33) yet.
- Related rows, such as a position's trades, need their own subscription until [relationships](https://github.com/tycoworks/tycostream/issues/2) land.

If something breaks, open an [issue](https://github.com/tycoworks/tycostream/issues).
