# tycostream

tycostream turns [Materialize](https://materialize.com/) views into GraphQL APIs, so you can quickly build real-time, type-safe apps.

- **Stream live data** - Subscribe to any SQL view and get typed updates over WebSockets
- **Model business logic** - Turn raw data into meaningful business states like safe/warning/critical
- **Trigger actions** - Fire webhooks when data meets specific conditions

---

## 🏁 Quickstart

### 1. Create configuration:

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

### 2. Generate schema for your views/tables:

```bash
# Download and run schema generator in one command
# Format: -s <source_name> -p <primary_key_column>
curl -sL https://raw.githubusercontent.com/tycoworks/tycostream/main/scripts/generate-schema.sh | \
  bash -s -- -s users -p id -s orders -p order_id > schema.yaml
```

### 3. Start tycostream:

```bash
docker run -p 4000:4000 --env-file .env \
  -v $(pwd)/schema.yaml:/app/schema.yaml \
  ghcr.io/tycoworks/tycostream:v0.1.0-preview
```

### 4. Test your API:

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

https://github.com/user-attachments/assets/20ca8223-cec1-43fa-bafb-868ce2ae9985

---

## Vision & Roadmap

tycostream aims to become the '**Hasura for streaming databases**.'

See the [vision](./docs/development/vision.md) and [roadmap](./docs/development/roadmap.md) for more details.
