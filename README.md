# tycostream

**tycostream** is a streaming server for Materialize. It turns any Materialize view into a real-time push API over Server-Sent Events (SSE).

---

## Features

* Streams updates over Server-Sent Events (SSE)
* Fan-out support to many connected clients
* Authorize clients using signed JWTs

---

## Why tycoworks

Getting  data from streaming databases (like Materialize) to a frontend or agent normally involves:

* Polling a view or materializing it to a static table - defeating the point of real-time
* Setting up a Kafka sink and managing complex Kafka infrastructure
* Hacking together a WebSocket or SSE relay using `SUBSCRIBE`

tycostream makes it easy to push real-time data over SSE with minimal configuration.

---

## Use Cases

* Powering real-time UIs
* Feeding AI or reactive agents with streaming data
* Anywhere you want live view data without polling

---

## Vision & Roadmap

The vision for tycostream is to become the 'Hasura for streaming databases' - a real-time, streaming GraphQL layer with minimal config and support for multiple streaming databases (Materialize, RisingWave, etc.).

* Scalability / high-availability
* Schema introspection / generation
* GraphQL subscription support
* Advanced filtering + entitlements
* RisingWave compatibility
* Live query layer

---

## 🏁 Quickstart & Configuration

Start the server:

```bash
git clone https://github.com/your-org/tycostream.git
cd tycostream
docker-compose up
```

Connect from your browser or frontend:

```js
const source = new EventSource("http://localhost:8000/stream");
source.onmessage = (e) => console.log(JSON.parse(e.data));
```

You’ll see real-time updates flowing in from your configured view.

Configure via `.env` or environment variables:

```env
SOURCE_HOST=your-mz-host
SOURCE_PORT=6875
SOURCE_USER=materialize
SOURCE_PASSWORD=materialize
SOURCE_DB=materialize
VIEW_NAME=live_pnl
```

---
