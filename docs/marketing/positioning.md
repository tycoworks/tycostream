# Product Positioning

## What is tycostream?

**tycostream** is a GraphQL layer for Materialize. It turns SQL views into typed APIs, so you can build streaming applications and dashboards faster.

## What are the main use cases?

There are two main use cases: as a component within an individual application, or as a central API layer used by many applications. At present, the roadmap is focused on the first use case.

### 1. Application Component
**Target:** Full-stack developers building a single application  
**Pattern:** tycostream runs as part of their application stack  
**Problem:** Getting live data from Materialize into their app is hard. Even when they build WebSocket servers and manage subscriptions, the data isn't type-safe and adding business logic like calculated states requires more custom code.  
**Solution:** Drop tycostream into their stack, get typesafe GraphQL subscriptions instantly. Build real-time features in hours, not weeks.

### 2. API Layer  
**Target:** Platform/infrastructure teams managing data across an organization  
**Pattern:** tycostream runs as a centralized API layer, like Hasura  
**Problem:** Multiple teams rebuilding the same streaming infrastructure, no consistent way to expose real-time data, security and governance challenges.  
**Solution:** Central tycostream deployment provides consistent, secure, governed access to streaming data across all teams.

## Application Component Positioning

### Tagline
"Build faster on Materialize"

### What it is
tycostream is a GraphQL layer for Materialize. It turns SQL views into typed APIs, so you can build streaming applications and dashboards faster.

### Core Capabilities

**Stream live data**  
Subscribe to any SQL view and get typed updates over WebSockets. Build reactive dashboards and real-time UIs without polling loops or custom WebSocket servers.  
_Feature: Views_

**Model business logic**  
Turn raw data into meaningful business states like safe/warning/critical. Define calculated fields and state transitions without touching the database or writing custom code.  
_Feature: States_

**Trigger actions**  
Fire webhooks when data meets specific conditions. Send alerts to Slack, trigger workflows in Zapier, or integrate with any external system based on your streaming data.  
_Feature: Triggers_