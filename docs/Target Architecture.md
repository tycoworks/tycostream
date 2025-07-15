## 🧱 High-Level Architecture (Updated)

### 🔄 1. One StreamManager per View

Each Materialize view (e.g., positions, orders) has its own `StreamManager` instance. This does:

* 🔌 Lazily connect to Materialize using `SUBSCRIBE` when the **first client subscribes**
* 🧠 Cache the current state in memory (`Map<primaryKey, { row, timestamp }>`), combining snapshot + stream cleanly
* 📢 Broadcast updates to all connected clients via a **ReplaySubject**, which acts as a tee stream

**Why?** You centralize ingestion, deduplication, and avoid N clients hammering Materialize. Lazy connection reduces load and startup cost.

Materialize’s `SUBSCRIBE` ensures snapshot and live updates are emitted in order, keyed by `timestamp` (which is populated from the `mz_timestamp` column in the case of Materialize). This means client-side stitching (e.g., tracking a snapshotHighWatermark) is unnecessary — we trust Materialize to maintain temporal correctness.

> 🔑 **Key insight**: We still avoid manual stitching, but ensure late joiners see all events safely using a **ReplaySubject** as a buffer.

---

### 📆 2. In-Memory Cache

Each `StreamManager` maintains:

* 🔹 A map of current state (`Map<id, { row, timestamp }>`), keyed by primary ID
* 🔹 A **ReplaySubject<rowChange>** that multicasts all events (acts as both live stream and buffer)

This setup allows you to:

* Store a durable cache of current state per view
* Broadcast updates to all connected clients in real time
* Rehydrate late subscribers immediately from the current cache
* Avoid gaps by using the ReplaySubject as the tee/buffer

ReplaySubject ensures nothing is missed, and ordering is preserved.

---

### 📡 3. Client Subscriptions (Late Joiner Logic)

```ts
import { ReplaySubject, filter } from 'rxjs';

function subscribeWithSnapshotFinal({
  stateMap,
  updates$,
  subscriber,
}) {
  // 1. Create a replayable tee stream
  const tee$ = new ReplaySubject(); // infinite size by default (be careful in prod)

  // 2. Begin teeing updates into it
  const teeSub = updates$.subscribe(event => tee$.next(event));

  // 3. Take snapshot and emit rows
  const snapshot = Array.from(stateMap.values());
  const latestSeenTimestamp = Math.max(...snapshot.map(({ timestamp }) => timestamp));
  subscriber.next(snapshot.map(({ row }) => row));

  // 4. Subscribe to tee$ with filter
  const liveSub = tee$.pipe(
    filter(({ timestamp }) => timestamp > latestSeenTimestamp)
  ).subscribe(subscriber);

  return () => {
    teeSub.unsubscribe();
    liveSub.unsubscribe();
  };
}
```

This approach ensures that:

* Snapshot is delivered first
* Any events missed during snapshot are replayed from the ReplaySubject
* No events are missed, duplicated, or out-of-order

> ⚠️ `ReplaySubject` guarantees any update after it is wired up will be available to late joiners.

---

### 👷 4. Startup Flow

On startup:

* Parse your `views.yaml`
* **Do not** instantiate any `StreamManager` yet
* First subscription triggers lazy creation of the relevant `StreamManager`
* `StreamManager` creates a `ReplaySubject`
* `StreamManager` starts consuming the stream via `SUBSCRIBE`
* For every update, push into both `ReplaySubject` and `stateMap`
* Updates start flowing to all clients

This flow guarantees snapshot and stream merge without duplication or gaps — relying on Materialize’s ordered semantics and ReplaySubject's replayability.

---

### 🔧 5. Optional Layering Later

This setup gives you clean expansion options:

* 📁 Multi-tenant or multi-view joins? Add a `QueryCompiler` layer
* 📀 Persistent caching? Swap in RxDB or Redis behind the in-memory map
* 🔒 Access control? Filter in `StreamManager.subscribeClient()`