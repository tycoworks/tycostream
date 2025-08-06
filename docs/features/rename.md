# Architecture Rename Plan

## Overview

This document outlines a comprehensive rename plan to align class names with their actual responsibilities and the layers they belong to. The goal is to make the codebase more intuitive and consistent.

## Core Principle

Services should be named after what they manage/produce:
- `SourceService` manages `Source` instances
- `ViewService` manages `View` instances
- `DatabaseStreamService` manages `DatabaseStream` instances
- Services are injectable (@Injectable decorator)
- Non-services are the actual domain objects

## Layer Structure

The application has three distinct layers:
1. **database** - Database connections and streaming
2. **streaming** - Caching, replay, and filtering
3. **graphql** - API interface

## Proposed Renames

### Database Layer (`src/database/`)

| Current Name | New Name | Rationale |
|-------------|----------|-----------|
| `DatabaseConnectionService` | `DatabaseStreamService` | Should manage DatabaseStream instances, not just connections |
| `DatabaseSubscriber` | `DatabaseStream` | It's a stream from the database, not a subscriber |
| `connection.service.ts` | `database-stream.service.ts` | Align with new responsibility |
| `subscriber.ts` | `database-stream.ts` | Align filename with class |
| `subscriber.spec.ts` | `database-stream.spec.ts` | Align test filename |

### Streaming Layer (`src/streaming/`)

| Current Name | New Name | Rationale |
|-------------|----------|-----------|
| `StreamingService` | `Source` | Not injectable, represents a cached data source |
| `StreamingManagerService` | `SourceService` | Injectable service that manages Source instances |
| `ViewService` | Keep as-is | Already follows pattern - manages View instances |
| `View` | Keep as-is | Clear domain object |
| `streaming.service.ts` | `source.ts` | Not a service file |
| `streaming.service.spec.ts` | `source.spec.ts` | Align test filename |
| `manager.service.ts` | `source.service.ts` | The actual service of this layer |
| `manager.service.spec.ts` | `source.service.spec.ts` | Align test filename |

### GraphQL Layer (`src/graphql/`)

All names in this layer are already correct and well-aligned.

## Architecture After Rename

```
GraphQL Layer:
  GraphQLSubscriptions 
    └── uses ViewService

Streaming Layer:
  ViewService (Injectable)
    ├── creates View instances
    └── uses SourceService
  
  SourceService (Injectable)
    ├── creates Source instances
    └── uses DatabaseStreamService
  
  Source (not Injectable)
    └── uses DatabaseStream (dependency injected)

Database Layer:
  DatabaseStreamService (Injectable)
    ├── creates DatabaseStream instances
    └── manages pg Client connections internally
  
  DatabaseStream (not Injectable)
    └── uses pg Client (provided by DatabaseStreamService)
```

## Key Architectural Fixes

### 1. Dependency Creation

**Current (Wrong):**
```typescript
// StreamingService creates its own DatabaseSubscriber
class StreamingService {
  constructor() {
    this.databaseSubscriber = new DatabaseSubscriber(...); // ❌
  }
}

// DatabaseConnectionService just creates clients
class DatabaseConnectionService {
  connect(): Client { 
    return new Client(); // Just a factory
  }
}
```

**After Rename (Correct):**
```typescript
// SourceService gets dependencies from other services
class SourceService {
  constructor(private databaseStreamService: DatabaseStreamService) {}
  
  createSource(sourceName: string) {
    const databaseStream = this.databaseStreamService.getStream(sourceName); // ✅
    const source = new Source(databaseStream, ...);
    return source;
  }
}

// DatabaseStreamService manages DatabaseStream instances
class DatabaseStreamService {
  private streams = new Map<string, DatabaseStream>();
  
  getStream(sourceName: string): DatabaseStream {
    if (!this.streams.has(sourceName)) {
      const client = await this.createClient(); // Internal
      this.streams.set(sourceName, new DatabaseStream(client, ...));
    }
    return this.streams.get(sourceName);
  }
}
```

### 2. Service vs Non-Service Clarity

**Injectable Services** (with @Injectable):
- `DatabaseStreamService` - manages database streams
- `SourceService` - manages sources
- `ViewService` - manages views

**Domain Objects** (not injectable):
- `DatabaseStream` - a database connection stream
- `Source` - a cached data source
- `View` - a filtered view

## Benefits

1. **Clarity**: Names match responsibilities
2. **Consistency**: All services follow the same pattern - they manage domain objects
3. **Layer Alignment**: Names reflect their layer
4. **Dependency Flow**: Clear ownership and creation patterns
5. **No Self-Creation**: Objects don't create their own dependencies

## Implementation Order

1. Refactor DatabaseConnectionService → DatabaseStreamService (to manage streams, not just connections)
2. Rename DatabaseSubscriber → DatabaseStream
3. Update SourceService to use DatabaseStreamService (not create its own streams)
4. Rename StreamingService → Source
5. Rename StreamingManagerService → SourceService
6. Update all imports and references
7. Update documentation

## Notes

- The term "Service" is reserved for NestJS injectable services
- Domain objects don't have "Service" suffix
- Each service manages instances of its corresponding domain object
- Services use other services via dependency injection, not by creating instances