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

### 1. Clone and configure:

```bash
git clone https://github.com/tycoworks/tycostream.git
cd tycostream
cp .env.example .env
```

### 2. Edit `.env`:

```
SOURCE_HOST=localhost
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize

GRAPHQL_PORT=4000
GRAPHQL_UI=true
```

### 3. Configure your schema:

```bash
cp config/schema.example.yaml config/schema.yaml
# Edit config/schema.yaml view name and fields to match your Materialize view
```

**Schema Requirements:** Your `config/schema.yaml` file must contain exactly one view definition.

### 4. Start the server:

```bash
docker-compose up
```

**Docker networking:** If Materialize runs on your host machine, update `.env`:
```
SOURCE_HOST=host.docker.internal
```

---

## Testing

For development testing, enable the GraphQL explorer:

```bash
GRAPHQL_UI=true npm run dev
```

Then visit `http://localhost:${GRAPHQL_PORT}/graphql` (default: http://localhost:4000/graphql) to test queries and subscriptions interactively.

Alternatively, use `curl` for queries or `npx` for subscriptions via command line.