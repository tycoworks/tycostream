## 1. Introducing tycostream

In my last two posts, I explored whether a streaming database could power a trading desk UI. The answer was a cautious yes: creating the backend logic was straightforward, but getting data into the frontend was surprisingly hard. I ended up building a custom WebSocket relay for the last mile which worked, but felt too brittle and difficult to maintain in the long term.

I wanted a better way, and so I've started working on a new project: **tycostream**. It turns streaming databases into real-time GraphQL APIs, ready to use with agents, dashboards, or anything that speaks GraphQL. The goal is to make it easier to build reactive applications and agents, without needing custom infrastructure or glue code.

There’s a lot of work ahead before it's production-ready, but the core functionality is ready for feedback. Let's take a look.

## 2. How It Works

tycostream works a bit like Hasura, but for streaming databases. You define the tables and views to expose, and tycostream generates typed GraphQL subscriptions from their schema. Clients can then subscribe to real-time updates using any GraphQL library such as Apollo GraphQL.

Under the hood, tycostream connects to Materialize using a standard Postgres connection, and uses the `SUBSCRIBE` functionality to stream data. When the first GraphQL subscription for a table or view is requested, tycostream opens a Materialize connection and starts maintaining a shared cache. As clients request the same subscription, tycostream serves them data from the cache as a snapshot, then connects them to the live update stream. As updates come in from Materialize, tycostream calculates and forwards only the changed fields to keep bandwidth usage low.

This design is inspired by view servers such as [Vuu](https://vuu.finos.org/) or the [Genesis Data Server](https://docs.genesis.global/docs/develop/server-capabilities/real-time-queries-data-server/), which are common components of financial markets applications. These components excel at streaming ticking prices, positions, and orders to thousands of connected UIs with fine-grained permissions and filtering. I wanted to build something similar but using open standards: GraphQL for the API and Postgres wire protocol for the database connection.