# E2E Tests

The e2e tests run tycostream against a real Materialize, which [Testcontainers](https://node.testcontainers.org/) starts in Docker. The image, `materialize/materialized:v26.49.1`, is pulled on the first run.

```bash
npm run e2e                                         # every suite
npm run e2e -- integration                          # suites whose file name matches
npm run e2e -- --exclude test/stress-test.e2e-spec.ts   # all but the stress test
```

## Suites

- **`database.e2e-spec.ts`**: `DatabaseService` on its own.
  - Live streams: the snapshot, then one batch per timestamp; filters; a window of the top rows; a failed stream leaving the others running; Materialize dropping the subscription when the consumer stops.
  - Snapshots: order, offset and limit; the time limit.
  - The connection cap (`DATABASE_MAX_CONNECTIONS`).
- **`integration.e2e-spec.ts`**: the whole server over HTTP.
  - Subscriptions: filters, one SSE message per timestamp, and only the columns a client selects.
  - Queries: filters, order and limit, and custom scalars in their JSON forms.
  - Materialize ending a subscription or query as soon as its client leaves.
- **`http.e2e-spec.ts`**: the HTTP layer, with no database. CORS, GraphiQL on and off, and a failed database connection ending one request with a GraphQL error while the server keeps serving.
- **`late-joiner.e2e-spec.ts`**: a client that joins while another is still receiving a large snapshot gets every row.
- **`stress-test.e2e-spec.ts`**: many clients, each subscribed to one department, while inserts, updates and deletes run; each client must end with its department's rows. It's the slow one. Tune it with:
  - `STRESS_TEST_ITERATIONS`: rounds of operations (default 100)
  - `STRESS_TEST_CLIENTS`: clients (default 10)
  - `STRESS_TEST_DELAY`: milliseconds between operations (default 5)

## Requirements

- Docker running. For a runtime other than Docker's default, see Testcontainers' [supported container runtimes](https://node.testcontainers.org/supported-container-runtimes/).
- Ports 4001, 4003, 4100 and 4200 free. The suites run one at a time, since they share ports and Docker.
