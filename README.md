<p align="center">
  <img src="docs/assets/logo.svg" width="96" alt="">
</p>

<h1 align="center">tycostream</h1>

<p align="center">Turn Materialize views into real-time GraphQL APIs</p>

<p align="center">
  <a href="https://github.com/tycoworks/tycostream/actions/workflows/ci.yml"><img src="https://github.com/tycoworks/tycostream/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/tycoworks/tycostream/releases/latest"><img src="https://img.shields.io/github/v/release/tycoworks/tycostream" alt="Latest release"></a>
  <a href="#licence"><img src="https://img.shields.io/badge/licence-MIT%20or%20Apache%202.0-blue" alt="Licence: MIT or Apache 2.0"></a>
</p>

tycostream serves [Materialize](https://materialize.com/) views as GraphQL queries and subscriptions over server-sent events. Each subscription runs in Materialize as its own `SUBSCRIBE`, so a client gets the current rows, then every change, one whole transaction at a time. Like [Hasura](https://hasura.io/), but for streaming.

https://github.com/user-attachments/assets/b56982b1-af99-4904-9cab-7b4fb788d765

*[positions-app](https://github.com/tycoworks/positions-app): live positions and trades, streamed from Materialize through tycostream.*

## Quickstart

Generate a `schema.yaml` for the views you want to serve, naming each one's primary key. The generator needs `psql`, and reads the `DATABASE_*` variables from the environment or a `.env` file (by default, Materialize on `localhost:6875`):

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s positions -p instrument_id > schema.yaml
```

Run tycostream:

```bash
docker run -p 4000:4000 \
  -e DATABASE_HOST=host.docker.internal \
  -e GRAPHQL_UI=true \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:latest
```

Then open http://localhost:4000/graphql.

## Example

Subscribe to a position:

```graphql
subscription {
  positions(where: { symbol: { _eq: "AAPL" } }) {
    operation
    data { symbol net_position latest_price market_value }
    fields
  }
}
```

The first message is the current row, and each one after it is a change. `fields` names the columns that changed, and the key; the others are `null`:

```json
[{ "operation": "INSERT",
   "data": { "symbol": "AAPL", "net_position": 870, "latest_price": 199.65, "market_value": 173695.5 },
   "fields": ["instrument_id", "symbol", "net_position", "latest_price", "market_value"] }]

[{ "operation": "UPDATE",
   "data": { "symbol": null, "net_position": null, "latest_price": 199.43, "market_value": 173504.1 },
   "fields": ["instrument_id", "latest_price", "market_value"] }]
```

A query takes the same arguments and returns the current rows once.

## Documentation

- [Guide](docs/guide.md): configuration, `schema.yaml` and the GraphQL API
- [Architecture](docs/architecture.md): how it works
- [Roadmap](docs/roadmap.md)
- [Why I built it](https://www.tycoworks.com/p/tycostream-turn-materialize-views)

Tested with Materialize v26.49.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
