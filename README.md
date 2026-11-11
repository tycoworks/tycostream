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

tycostream turns [Materialize](https://materialize.com/) views into GraphQL queries and subscriptions, so you can build real-time, type-safe apps. Like [Hasura](https://hasura.io/), but for streaming.

## Features

- **Queries and subscriptions** for any table or view over server-sent events
- **Hasura-style** filtering, sorting and paging
- **Batched updates** for transactional consistency
- **Incremental updates** with only the fields that changed

## Getting started

1. **Describe your views.** Generate a [`schema.yaml`](docs/guide.md#step-1-describe-your-views) that lists the tables and views to serve, with the [schema generator](scripts/generate-schema.sh).
2. **Run tycostream.** Start the Docker image, `ghcr.io/tycoworks/tycostream`, with your database's [connection settings](docs/guide.md#step-2-run-tycostream) and your `schema.yaml`.
3. **Query and subscribe.** Try your [API](docs/guide.md#step-3-query-and-subscribe) in the built-in GraphQL explorer, then connect any GraphQL client.

## See it working

[positions-app](https://github.com/tycoworks/positions-app) streams live positions and trades from Materialize to a browser through tycostream.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
