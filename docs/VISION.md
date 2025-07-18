# Vision

## Problem
Exposing real-time data from streaming databases like Materialize to frontends, agents, and user-facing systems is still harder than it should be. Teams often resort to polling, Kafka pipelines, or custom relays—approaches that work, but don’t fit together easily and are painful to maintain.

---

## 10x Solution
**tycostream** is the  **Hasura for streaming databases**. It provides a **real-time, low-latency GraphQL layer** that turns live SQL views into streaming APIs—with filtering, entitlements, and live query support out of the box.

Developers can instantly expose secure, scalable streaming APIs using only configuration—no boilerplate or infrastructure headaches. This enables reactive apps, dashboards, and agents to consume structured streaming data directly, without middleware or polling layers.

---

## Use Cases  
- **Internal tools and dashboards** that need instant updates without polling  
- **Trading and monitoring systems** where low-latency matters  
- **AI agents** that act on live signals from SQL sources  
- **Data product APIs** for securely exposing real-time data to clients  
- **Prototypes and internal apps** where speed > boilerplate  

---

## Core Beliefs
We believe an ecosystem will form around streaming databases, just like it did for Postgres:

* **Streaming databases will become common.** As more systems shift to real-time—from financial trading to AI agents—tools like Materialize and RisingWave will become part of the default stack.
* **Backends are being composed, not hand-built.** Developers now reach for platforms like Hasura or WunderGraph to stitch services together without writing everything from scratch.

---

## Why Now
* **Streaming databases are maturing.** Materialize, RisingWave, and others are production-ready and Postgres-compatible.
* **GraphQL is stable.** It is now a standard interface for front-end & agents, and a mature ecosystem exists across tools, clients, and hosting.
* **Live Queries and SSE are ready.** Browser support is near-universal and well understood.
* **AI agents and reactive systems need real-time.** Kafka is heavyweight; polling doesn't scale.