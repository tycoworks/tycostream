# tycostream

tycostream turns your streaming database into a real-time GraphQL API.

---

## Features

* Works with [Materialize](https://materialize.com/) views and tables
* Streams live updates over GraphQL subscriptions (WebSockets)
* Works with standard GraphQL clients (e.g. Apollo)

---

## Why tycostream

Getting data from streaming databases (like Materialize) to a frontend or agent normally involves:

* Polling a view or piping it to a static table — defeating the point of real-time
* Setting up a Kafka sink and therefore managing complex infrastructure
* Hacking together a WebSocket or SSE relay using `SUBSCRIBE`

tycostream makes it easy to expose real-time data over GraphQL for:
* Powering real-time UIs
* Feeding AI or reactive agents with streaming data
* Any use case where you need streaming data without polling

---

## Vision & Roadmap

tycostream aims to become the '**Hasura for streaming databases**.'

See the [vision](./docs/VISION.md) and [roadmap](./docs/ROADMAP.md) for more details.

---

## 🏁 Quickstart & Configuration

### 1. Clone and configure:

```bash
git clone https://github.com/tycoworks/tycostream.git
cd tycostream
cp .env.example .env
```

### 2. Edit `.env`:

```
DATABASE_HOST=localhost
DATABASE_PORT=6875
DATABASE_USER=materialize
DATABASE_PASSWORD=materialize
DATABASE_NAME=materialize

GRAPHQL_PORT=4000
GRAPHQL_UI=true
```

### 3. Configure your schema:

```bash
cp config/schema.example.yaml config/schema.yaml
# Edit config/schema.yaml to match your database sources (run SHOW COLUMNS in your database)
```

### 4. Start the server:

```bash
docker-compose up
```

**Docker networking:** If Materialize runs on your host machine, update `.env`:
```
DATABASE_HOST=host.docker.internal
```

---

## Testing

Enable the built-in GraphQL Explorer UI:
```bash
GRAPHQL_UI=true npm run dev
```
Then visit http://localhost:4000/graphql to test queries and subscriptions interactively.

---

## Demo

See a complete example implementation at https://github.com/tycoworks/tycostream-demo