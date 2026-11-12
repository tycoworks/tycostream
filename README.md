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

tycostream turns [Materialize](https://materialize.com/) views into GraphQL queries and subscriptions, so you can quickly build real-time, type-safe apps. Like [Hasura](https://hasura.io/), but for streaming.

## Features

- **Queries and subscriptions** over server-sent events
- **Nested joins** with filtering, sorting and paging
- **Incremental updates** with only the fields that changed
- **Batched updates** for transactional consistency

## Getting started

Follow these three steps, and see the [guide](docs/guide.md) and [API reference](docs/api.md) for more detail.

1. **Describe your schema.** Write a `schema.yaml` that lists the tables and views to serve. You can generate it with the [schema generator script](skills/create-schema/scripts/generate-schema.sh), or with the [create-schema](skills/create-schema) agent skill:

   ```bash
   npx skills add tycoworks/tycostream
   ```

2. **Run tycostream.** Start the Docker image with your `schema.yaml` and your database's [connection settings](docs/guide.md#step-2-run-tycostream). To run it against Materialize on your own machine:

   ```bash
   docker run -p 4000:4000 \
     -e DATABASE_HOST=host.docker.internal \
     -e GRAPHQL_UI=true \
     -v $(pwd)/schema.yaml:/app/schema.yaml \
     ghcr.io/tycoworks/tycostream:latest
   ```

3. **Query and subscribe.** Open the GraphQL explorer at http://localhost:4000/graphql, try a query and a subscription, then connect any GraphQL client.

## See it working

[positions-app](https://github.com/tycoworks/positions-app) streams live positions and trades from Materialize to a browser through tycostream.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache 2.0](LICENSE-APACHE), at your option.
