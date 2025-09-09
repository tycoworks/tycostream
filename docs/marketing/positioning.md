# Product Positioning

## What is tycostream?

**tycostream** is a GraphQL layer for streaming databases like Materialize. It turns SQL views into typed APIs that developers can use directly in their applications.

## Two Use Cases, Two Personas

### Use Case A: Application Component (Current Focus)
**Target:** Full-stack developers building a single application  
**Pattern:** tycostream runs as part of their application stack  
**Problem:** Getting live data from Materialize into their app requires building WebSocket servers, managing subscriptions, and handling state changes. Weeks of plumbing before they can build features.  
**Solution:** Drop tycostream into their stack, get typesafe GraphQL subscriptions instantly. Build real-time features in hours, not weeks.  
**Positioning:** "Build streaming apps faster—and safer—with Materialize"

### Use Case B: API Platform (Future Vision)  
**Target:** Platform/infrastructure teams managing data across an organization  
**Pattern:** tycostream runs as a centralized API layer, like Hasura  
**Problem:** Multiple teams rebuilding the same streaming infrastructure, no consistent way to expose real-time data, security and governance challenges.  
**Solution:** Central tycostream deployment provides consistent, secure, governed access to streaming data across all teams.  
**Positioning:** "Hasura for streaming databases"

## Use Case A Positioning (For Developers)

### Tagline
"Build streaming apps faster—and safer—with Materialize"

### What it is
A typesafe GraphQL layer for Materialize that runs alongside your application.

### What you can do with it
- **Live Views:** Subscribe to any SQL view and get typed updates over WebSockets
- **Calculated States:** Turn raw data into meaningful enums (safe/warning/critical)
- **Triggers:** Fire webhooks when data meets specific conditions

### Why it's good
- **Typesafe:** Full TypeScript/GraphQL types generated from your schema
- **Fast:** From SQL view to live subscription in minutes
- **Simple:** No WebSocket servers, no polling loops, no state management code

### The Developer Pitch
"You've built amazing SQL views in Materialize. Now you need them in your app, updating live. tycostream makes that connection trivial—and typesafe. Write a SQL view, get a GraphQL subscription, ship your feature."

## Use Case B Positioning (For Platform Teams)

### Tagline
"The Hasura for streaming databases"

### What it becomes
A centralized API platform for exposing streaming data across your organization.

### Additional capabilities
- Multi-source federation
- Row-level security
- Team-based access control  
- Audit trails
- SLA monitoring

### The Platform Pitch
"Just as Hasura standardized API access to PostgreSQL, tycostream standardizes access to streaming databases. One deployment, consistent APIs, governed access—streaming data becomes as easy to consume as REST endpoints."