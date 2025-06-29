# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

tycostream is a real-time GraphQL API server that streams updates from Materialize views to clients over WebSockets. It's designed as a foundation-layer service with emphasis on correctness, modularity, and testability.

## Architecture

**Single-Process Design (Milestone 1):**
- Single Node.js + TypeScript backend combining both Materialize streaming and GraphQL delivery
- Modular internal separation to support future process decomposition in Milestone 2
- In-memory EventEmitter for internal pub/sub communication

### Project Structure
- `/backend/` – Node.js + TypeScript service handling both streaming and GraphQL logic
- `/graphql/` – SDL schemas and metadata config  
- `/shared/` – event definitions, config, logging, types
- `/tests/` – unit and integration tests

### Internal Event Format
```typescript
{ row: Record<string, any>, diff: number }
```

## Development Commands

When implemented, expected commands:
- `npm run test` - Run tests with Vitest
- `npm run test -- --watch` - Watch mode during development
- `npm run build` - Build TypeScript
- `npm run dev` - Development mode
- `npm start` - Production mode

## Testing Philosophy

- Every function must be unit tested
- Every component must have contract-level integration tests
- Use Vitest as test runner
- Tests live in `/tests` mirroring source structure
- Follow Given/When/Then pattern
- Mock Postgres connection for unit tests, use real Materialize for integration tests

## Key Implementation Guidelines

- **Plain Node.js + TypeScript**: No frameworks, no DI containers, idiomatic Node.js
- **Bias for simplicity**: readable over clever
- **Structure around interfaces**, not implementation details
- **Build for replaceability**: no hidden state or tight coupling
- **Fail-fast startup**: Exit with non-zero code if schema missing or config invalid
- Use structured logging for streaming operations
- No code is complete without passing tests

## Schema Requirements

- Schema files at `./schema/{VIEW_NAME}.sdl` relative to backend working directory
- Each view must have exactly one field marked with `ID!` (used as primary key)
- 1:1 mapping between GraphQL subscription field name and VIEW_NAME
- Static schema loading only (no dynamic generation in Milestone 1)

## Configuration

Environment variables:
- `SOURCE_HOST` - Materialize host
- `SOURCE_PORT` - Materialize port (default 6875)
- `SOURCE_USER` - Database user
- `SOURCE_PASSWORD` - Database password
- `SOURCE_DB` - Database name
- `VIEW_NAME` - View to stream from