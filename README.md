# tycostream

tycostream turns [Materialize](https://materialize.com/) into a real-time GraphQL API.

---

## Features

* Works with Materialize Views and Tables
* Streams live updates (diffs) over GraphQL subscriptions (WebSockets)
* Supports filtering subscriptions with Hasura-like 'where' clauses
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

See the [vision](./docs/development/vision.md) and [roadmap](./docs/development/roadmap.md) for more details.

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

SCHEMA_PATH=./schema.yaml
LOG_LEVEL=debug
```

### 3. Configure your schema:

```bash
cp schema.example.yaml schema.yaml
# Edit schema.yaml to match your database sources
# Use PostgreSQL wire protocol type names (e.g., 'character varying' not 'varchar')
# Get exact type names: SHOW COLUMNS FROM your_view
```

### 4. Start the server:

**Option A: Using npm**
```bash
npm install
npm start
```

**Option B: Using Docker**
```bash
docker-compose up --build
```

If Materialize runs on your host machine, update `.env`:
- macOS/Windows: `DATABASE_HOST=host.docker.internal`
- Linux: `DATABASE_HOST=172.17.0.1`

---

## Testing

Enable the built-in GraphQL Explorer UI by setting `GRAPHQL_UI=true` in your `.env` file.
Then visit http://localhost:4000/graphql to test queries and subscriptions interactively.

---

## Demo

Run the included live demo:
```bash
npm run demo
```

This starts a complete example with:
- Live market data streaming  
- Real-time position tracking
- AG-Grid frontend with WebSocket subscriptions

Visit http://localhost:5173 to see the demo UI.

https://github.com/user-attachments/assets/20ca8223-cec1-43fa-bafb-868ce2ae9985
