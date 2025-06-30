# tycostream

tycostream turns any [Materialize](https://materialize.com/) view into a real-time GraphQL API over WebSockets.

---

## Features

* Streams live updates over GraphQL subscriptions (WebSockets)
* Instant setup from Materialize views with minimal config
* Works with standard GraphQL clients (e.g. Apollo)

---

## Why tycostream

Getting data from streaming databases (like Materialize) to a frontend or agent normally involves:

* Polling a view or materializing it to a static table — defeating the point of real-time
* Setting up a Kafka sink and managing complex Kafka infrastructure
* Hacking together a WebSocket or SSE relay using `SUBSCRIBE`

tycostream makes it easy to expose real-time data over GraphQL with minimal boilerplate.

---

## Use Cases

* Powering real-time UIs
* Feeding AI or reactive agents with streaming data
* Anywhere you want live view data without polling

---

## Vision & Roadmap

tycostream aims to become the '**Hasura for streaming databases**.'

See the [vision](./docs/VISION.md) and [roadmap](./docs/ROADMAP.md) for more details.

---

## 🏁 Quickstart & Configuration

### Start the server:

```bash
git clone https://github.com/tycoworks/tycostream.git
cd tycostream
cp .env.example .env
# Edit .env with your Materialize connection details

cp config/schema.example.sdl config/schema.sdl
# Edit config/schema.sdl to match your Materialize view structure
docker-compose up
```

### Connect from your frontend using Apollo Client:

```js
import { gql, useSubscription } from '@apollo/client';

const LIVE_PNL_SUBSCRIPTION = gql`
  subscription {
    live_pnl {
      instrument_id
      symbol
      net_position
      latest_price
      market_value
      theoretical_pnl
    }
  }
`;

const { data } = useSubscription(LIVE_PNL_SUBSCRIPTION);
```

### Configure via `.env` or environment variables:

```
SOURCE_HOST=localhost
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize
VIEW_NAME=live_pnl
```
