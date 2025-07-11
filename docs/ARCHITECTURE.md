# System Architecture
*High-level system design, technology choices, and component architecture*

## Overview

This document outlines the system architecture for tycostream: a real-time GraphQL API that streams updates from Materialize views to subscribed clients. The system is implemented as a single Node.js process combining Materialize streaming and GraphQL delivery logic in one modular backend.

## System Goals

* Stream updates from Materialize views to GraphQL clients over WebSocket
* Support multiple concurrent client subscriptions with isolation
* Deliver current view state followed by incremental updates
* Manually defined schema using YAML configuration files
* Minimal configuration surface for users
* Clean, extensible architecture that supports future enhancements

---

## Key Components

### Backend Service

* Built using Node.js + TypeScript
* Connects to Materialize using the Postgres wire protocol
* Parses incoming row updates and applies them to the Central View Cache

### Central View Cache

* Maintains the current state of a Materialize view in memory
* Receives row updates from the Backend Service and applies diffs (insert/update/delete)
* Notifies all active Client Stream Handlers of state changes
* Provides current view data for new client connections
* Lock-free implementation supporting low-latency concurrent reads
* Never blocks incoming Materialize updates while serving client requests

### Client Stream Handler

* Created for each GraphQL client subscription
* Subscribes to Central View Cache using single event stream
* Receives current view state as individual events, then live updates
* Uses p-queue library for robust async queue management
* Manages lifecycle from connection to disconnection
* Provides isolation between different client streams

### GraphQL API Server

* Serves a WebSocket endpoint for GraphQL subscriptions using GraphQL Yoga
* Dynamically generates GraphQL schema from YAML configuration
* Creates a new Client Stream Handler for each client subscription
* Uses async iterators to stream data to clients

---

## Data Flow

1. **Startup**: Backend validates configuration and loads GraphQL schema from YAML
2. **Connection**: Backend connects to Materialize using Postgres wire protocol
3. **Streaming**: Issues `SUBSCRIBE` query against configured view
4. **Cache Initialization**: Initial rows populate the Central View Cache with current state
5. **Update Processing**: As row updates arrive:
   - Backend Service parses the update
   - Update is immediately applied to Central View Cache (non-blocking)
   - Cache notifies all registered Client Stream Handlers
6. **Client Connection**: GraphQL server receives subscription request via WebSocket
7. **Subscription Setup**: New Client Stream Handler subscribes to cache
8. **Unified Stream**: Client receives current state as individual events, then live updates
9. **Consistent Ordering**: All events maintain strict Materialize stream ordering

---

## Deployment Model
* Single Node.js process containing all components
* Materialize streaming logic and GraphQL server run in the same service
* Modular codebase with clean separation between streaming and GraphQL layers