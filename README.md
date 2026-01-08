# tycostream

tycostream turns [Materialize](https://materialize.com/) views into GraphQL APIs, so you can quickly build real-time, type-safe apps. Like [Hasura](https://hasura.io/), but for streaming use cases.

**Key features:**
- **Subscriptions** — Subscribe to any view and get updates over WebSockets
- **Triggers** — Fire webhooks when data meets specific conditions

[Learn more about why I built this →](https://tycoworks.substack.com/p/tycostream-turn-materialize-views)

---

## Quickstart

### 1. Configure connection details

```bash
# Create .env file with your database connection
echo "DATABASE_HOST=localhost
DATABASE_PORT=6875
DATABASE_USER=materialize
DATABASE_PASSWORD=materialize
DATABASE_NAME=materialize
GRAPHQL_PORT=4000
GRAPHQL_UI=true
SCHEMA_PATH=./schema.yaml
LOG_LEVEL=debug" > .env

# If Materialize runs on your host machine and you're using Docker:
# macOS/Windows: Change DATABASE_HOST to host.docker.internal
# Linux: Change DATABASE_HOST to 172.17.0.1
```

### 2. Create a schema file

You need to tell tycostream which tables and views to expose in your API. For example, given a `trades` table like this:

```sql
CREATE TABLE trades (
  id INT,
  instrument_id INT,
  side TEXT,           -- 'buy' or 'sell'
  quantity INT,
  price NUMERIC,
  executed_at TIMESTAMP
);
```

You would need a `schema.yaml` file like this:

```yaml
enums:
  side:
    - buy
    - sell

sources:
  trades:
    primary_key: id
    columns:
      id: Integer
      instrument_id: Integer
      side: side              # mapped to enum
      quantity: Integer
      price: Float
      executed_at: Timestamp
```

You can use the bundled generator script to create schema files directly from your Materialize instance. For the trades table example above, the command would look like this:

```bash
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -e side "buy,sell" -s trades -p id -c side:side > schema.yaml
```

### 3. Start tycostream

```bash
docker run -p 4000:4000 --env-file .env \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:v0.1.0-preview
```

### 4. Test your API

Visit http://localhost:4000/graphql to explore your GraphQL API with the built-in UI (enabled by `GRAPHQL_UI=true` in .env).

---

## Building from Source

### Getting Started

For development, customization, or running the demo:

```bash
git clone https://github.com/tycoworks/tycostream.git
cd tycostream
npm install
npm run build
npm start
```

### Running the Demo

Once you've cloned and installed:

```bash
npm run demo
```

This starts a complete example with:
- Live market data streaming
- Real-time position tracking
- AG-Grid frontend with WebSocket subscriptions

Visit http://localhost:5173 to see the demo UI.

https://github.com/user-attachments/assets/c5406eb6-0f1e-48ae-ae78-0cadb874b443

---

## What's Next

See the [roadmap](./docs/roadmap.md) for planned features.
