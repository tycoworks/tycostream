## Structure

**Section 4: Try It Out**
- "Here's what it looks like" → embed 9-second MP4 demo
- Current limitations (no auth yet, etc.) but working on it
- What's next: filtering and client-side subscriptions (link to roadmap)
- Call for feedback and contribution
- Links: demo, GitHub, DMs open

---

## 1. Introducing tycostream

In my last two posts ([part 1](https://www.tycoworks.com/p/can-a-stream-processor-power-a-trading) and [part 2](https://www.tycoworks.com/p/can-a-stream-processor-power-a-trading-196)), I explored whether a streaming database could power a trading desk UI. The answer was a cautious yes: creating the backend logic was straightforward, but getting data into the frontend was surprisingly hard. I ended up building a custom WebSocket relay for the last mile which worked, but felt too brittle and difficult to maintain in the long term.

I wanted a better way, and so I've started working on a new project: [tycostream](https://github.com/tycoworks/tycostream). It turns streaming databases into real-time GraphQL APIs, ready to use with agents, dashboards, or anything that speaks GraphQL. The goal is to make it easier to build reactive applications and agents, without needing custom infrastructure or glue code.

There’s a lot of work ahead before it's production-ready, but the core functionality is ready for feedback. Let's take a look.

## 2. How It Works

tycostream works a bit like [Hasura](https://hasura.io/), but for streaming databases. You define the tables and views to expose, and tycostream generates typed GraphQL subscriptions from their schema. Clients can then subscribe to real-time updates using any GraphQL library such as [Apollo Client](https://github.com/apollographql/apollo-client).

Under the hood, tycostream connects to[Materialize](https://materialize.com/) using a standard Postgres connection. When the first subscription for a table or view comes in, tycostream opens a `SUBSCRIBE` query and starts maintaining a shared cache. New requests for the same subscription are served from the cache, along with live updates of only changed fields to reduce overhead.

This design is inspired by view servers such as [Vuu](https://vuu.finos.org/) or the [Genesis Data Server](https://docs.genesis.global/docs/develop/server-capabilities/real-time-queries-data-server/), which are common components of financial markets applications. These components excel at streaming ticking prices, positions, and orders to thousands of connected UIs with fine-grained permissions and filtering. I wanted to build something similar but using open standards: GraphQL for the API and Postgres wire protocol for the database connection.

## 3. Where This is Going

I believe we'll see growing demand for streaming applications, and that streaming databases like Materialize will be front and center. They make it easy to build scalable, real-time applications using standard SQL, and in the future, I expect they'll be as ubiquitous as Postgres is for static data.

Like Postgres, I expect an ecosystem of tools will form around streaming databases, creating a foundation for building reactive applications. We'll have API layers for access, entitlements for security, and ways to trigger logic when data changes. I think we'll see a new paradigm emerge: CRUDS — Create, Read, Update, Delete, and Stream — where streaming becomes a first-class capability.

This would enable anyone to build reactive applications quickly and safely. Imagine vibe coding a position-keeping application in [Lovable](https://lovable.dev/), and under the hood it snaps together [Supabase](https://supabase.com/), Materialize and tycostream with minimal glue. The world is moving towards composable backends, and tycostream aims to make the streaming part easy.

## 4. Try It Out

[Section 4 content to be written]