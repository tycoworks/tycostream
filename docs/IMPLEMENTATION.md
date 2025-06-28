# Implementation details and approach
## 1. Philosophy

> This project is a foundation-layer service. Our goal is correctness, modularity, testability, and maintainability — not premature optimization.
> 

Key points:

- **Bias for simplicity and clarity**: readable over clever.
- **Structure around interfaces**, not implementation details.
- **Build for replaceability**: no hidden state, hard-coded logic, or tight coupling.

---

## 2. Project Structure

Outline how code should be organized:

- `/encore/` – Materialize streaming client
- `/graphql/` – Yoga schema, resolvers, field logic
- `/shared/` – event definitions, config, logging, types
- `/tests/` – isolated unit tests per module, integration tests

---

## 3. Modularity Guidelines

- Each component must expose a **clear interface**.
- No circular dependencies — isolate read/update responsibilities.
- Pub/sub, cache, filters, schema loaders — all should be **plug-and-play**.
- Design so that **runtime state (e.g. cache)** can be mocked or injected.

---

## 4. Test-Driven Development

- Every function must be **unit tested** — no untested logic.
- Every component must have **contract-level integration tests**.
- Prefer:
    
    ```
    ts
    CopyEdit
    // Given input A
    // When we perform operation B
    // Then we expect result C
    
    ```
    
- Tests should live in `/tests` and mirror the source structure.
- Use `Vitest` (or equivalent) as the test runner.

### Run tests locally:

```bash
bash
CopyEdit
npm run test             # one-time test run
npm run test -- --watch  # watch mode during dev

```

> No code is considered complete until it has a passing test.
> 

---

## 5. Logging & Observability

- Use structured logs for every streaming operation:
    - `stream.connected`, `stream.updateReceived`, `stream.updateParsed`
- Log at `info` level by default; `debug` for verbose data; `warn`/`error` for failures.
- Add tracing tags for view, operation, and diff count.

---

## 6. Performance

> This system should be efficient — but not at the cost of maintainability (yet).
> 
- In 1.x, **favor clarity over micro-optimization**.
- Avoid tight loops or serialization bottlenecks where possible.
- Benchmark message latency at component boundaries in Milestone 2.