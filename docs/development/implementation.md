# Implementation Standards

## Development Philosophy

> This project is a foundation-layer service. Our goal is correctness, modularity, testability, and maintainability — not premature optimization.

### Core Principles

- **Clarity over cleverness**: Write code that is immediately understandable
- **Explicit over implicit**: Make intentions clear, avoid magic
- **Composition over inheritance**: Prefer small, composable functions
- **Pure functions where possible**: Minimize side effects
- **Fail fast**: Validate early and provide clear error messages

## Code Organization

### Directory Structure
- Follow NestJS module organization (feature modules)
- Each module contains its services, types, and tests
- Use barrel exports (index.ts) sparingly
- Spec files co-located with implementation (.spec.ts)

### Module Guidelines
- Each NestJS module should have a single, clear responsibility
- Use @Module() decorators to define module boundaries
- Export only services needed by other modules
- Use dependency injection for inter-module communication
- Avoid circular dependencies between modules

## TypeScript Standards

### Type Safety
- Enable strict mode in tsconfig.json
- Avoid `any` - use `unknown` when type is truly unknown
- Define explicit return types for public functions
- Use const assertions for literal types

### Naming Conventions
- **Files**: kebab-case with type suffix (e.g., `database-connection.service.ts`)
- **Services**: PascalCase with Service suffix (e.g., `DatabaseConnectionService`)
- **Modules**: PascalCase with Module suffix (e.g., `DatabaseModule`)
- **Interfaces**: PascalCase with descriptive names (avoid `I` prefix)
- **DTOs**: PascalCase with Dto suffix (e.g., `CreateTradeDto`)
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE for true constants, camelCase for configuration
- **Injection tokens**: UPPER_SNAKE_CASE (e.g., `SOURCE_CONFIG`)

## Dependency Management

### Library Selection Criteria
**CRITICAL: Prefer well-established libraries over custom implementations**

1. **Check npm first**: Before writing any utility, search for existing solutions
2. **Evaluation criteria**:
   - Weekly downloads > 10,000
   - Last publish < 1 year ago
   - Clear documentation
   - TypeScript support or quality @types package
   - Appropriate license

### When to Use Libraries

**Always use libraries for**:
- Framework (NestJS - includes Express/Fastify)
- Database clients (official drivers)
- Validation (class-validator, class-transformer)
- Date/time manipulation (date-fns, dayjs)
- Logging (NestJS built-in logger, Pino, Winston)
- Testing (Jest - NestJS default)
- Async utilities (rxjs - built into NestJS)
- File parsing (yaml, csv-parse)
- Configuration (@nestjs/config)

**Write custom code for**:
- Core business logic
- Domain-specific algorithms
- Simple utilities where a library would be overkill
- Performance-critical hot paths

**Document all decisions**: When choosing between library and custom, add a comment explaining why.

## Code Quality Standards

### No Magic Numbers or Strings
```typescript
// Bad
setTimeout(() => {}, 5000);
if (retries > 3) { }

// Good
const RECONNECT_DELAY_MS = 5000;
const MAX_RETRIES = 3;
setTimeout(() => {}, RECONNECT_DELAY_MS);
if (retries > MAX_RETRIES) { }
```

### Component-Local Constants
Keep configuration close to where it's used:

```typescript
// In database/connection.ts
const CONNECTION_TIMEOUT_MS = 10000;
const KEEPALIVE_INTERVAL_MS = 30000;

// In graphql/server.ts
const DEFAULT_PORT = 4000;
const SHUTDOWN_TIMEOUT_MS = 5000;
```

### Eliminate Duplication
- If you write similar code twice, extract a function
- If you define similar types twice, create a shared type
- If you handle similar errors twice, create an error handler

## Error Handling

### Fail Fast Philosophy
- **Exit immediately** on configuration errors or unrecoverable states
- **Validate everything at startup** - schema files, environment variables, port availability
- **No partial states** - either fully operational or not running
- **Clear error messages** with actionable guidance for users
- **Graceful shutdown** - clean up resources in reverse order of initialization

### Error Handling Principles
- Include context in errors (what failed, why, what to do)
- Use custom error classes for domain-specific errors
- Log errors at the boundary, not throughout the stack
- Exit with appropriate codes (1 for general errors, specific codes for known issues)

### Example
```typescript
class ConfigError extends Error {
  constructor(message: string, public field: string) {
    super(`Configuration error in ${field}: ${message}`);
    this.name = 'ConfigError';
  }
}
```

### User-Facing Error Messages
- Avoid technical jargon ("unhandled promise rejection", "SUBSCRIBE query")
- Use clear language ("database connection failed", "schema file not found")
- Provide next steps ("Check your .env file", "Ensure Materialize is running")
- Include relevant context without exposing sensitive data

## Logging Strategy

### Log Levels
- **ERROR**: System failures requiring immediate attention
- **WARN**: Recoverable issues that may indicate problems  
- **INFO**: Key business events (startup, connections, operations)
- **DEBUG**: Detailed operational information (use sampling for high-frequency events)

### What We Log
- System lifecycle events
- Connection state changes
- GraphQL operations
- Errors with full context
- Performance metrics (sampled)

### Standards
- Use structured logging with consistent field names
- Create child loggers per component
- No emojis in logs
- Never log sensitive data (passwords, tokens, PII)
- Present tense ("Starting server" not "Started server")
- Include units in measurements ("45ms" not "45")

## NestJS-Specific Standards

### Dependency Injection
- Use constructor injection exclusively
- Prefer interfaces for service contracts
- Use @Injectable() decorator on all services
- Use custom providers for configuration objects
- Avoid service locator pattern

### Service Design
```typescript
// Good - Injectable service with clear dependencies
@Injectable()
export class DatabaseStreamingService {
  constructor(
    private readonly connection: DatabaseConnectionService,
    private readonly cache: CacheService,
    @Inject('SOURCE_CONFIG') private readonly config: SourceConfig
  ) {}
}

// Bad - Manual instantiation
export class DatabaseStreamer {
  private cache = new Cache();
  constructor() {
    this.connection = new Connection();
  }
}
```

### Module Organization
```typescript
@Module({
  imports: [ConfigModule],
  providers: [
    DatabaseConnectionService,
    DatabaseStreamingService,
    {
      provide: 'SOURCE_CONFIG',
      useFactory: (config: ConfigService) => config.get('sources'),
      inject: [ConfigService],
    },
  ],
  exports: [DatabaseStreamingService], // Only export what's needed
})
export class DatabaseModule {}
```

### RxJS Integration
- Return Observables from services, not Promises
- Use RxJS operators for transformations
- Leverage shareReplay for multicasting
- Handle cleanup in Observable teardown logic

## Testing Standards

### Test Structure
- Use Jest with NestJS testing utilities
- Create testing modules with Test.createTestingModule()
- Mock providers using NestJS testing tokens
- Use descriptive test names that explain the scenario
- Follow Arrange-Act-Assert pattern
- One assertion per test when possible
- Use beforeEach for common setup

### Test Categories
1. **Unit Tests**: Pure functions, individual classes
2. **Integration Tests**: Module interactions, external services
3. **End-to-End Tests**: Full system behavior (sparingly)

### Mocking Strategy
- Mock at module boundaries, not internals
- Prefer dependency injection over module mocking
- Use real implementations when fast enough

## Async Code Patterns

### Promise Handling
- Use async/await over raw promises
- Handle errors with try/catch
- Avoid mixing callbacks with promises

### Streaming Patterns
- Use async iterators for pull-based streams
- Use RxJS Observables for push-based events
- Document backpressure handling strategy

## Performance Considerations

### When to Optimize
1. Write clear, correct code first
2. Measure with real workloads
3. Optimize only proven bottlenecks
4. Document performance-critical sections

### Memory Management
- Be conscious of closure scope in hot paths
- Clear references to allow garbage collection
- Use streaming for large datasets

## Documentation

### Code Comments
- Explain "why", not "what"
- Document complex algorithms
- Note any non-obvious side effects
- Keep comments up-to-date with code

### API Documentation
- Document all public interfaces
- Include examples for complex APIs
- Specify error conditions
- Note breaking changes

## Security Considerations

### Input Validation
- Validate all external input
- Use schema validation libraries
- Sanitize before logging
- Never trust client-provided data

### Secrets Management
- Never commit secrets
- Use environment variables
- Document required permissions
- Rotate credentials regularly