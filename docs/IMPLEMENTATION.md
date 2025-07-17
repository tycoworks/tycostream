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
- Group by feature, not by file type
- Co-locate related functionality
- Keep test files near the code they test
- Shared utilities should have clear, specific purposes

### Module Guidelines
- Each module should have a single, clear responsibility
- Export only what's necessary - keep internals private
- Use TypeScript interfaces to define contracts between modules
- Avoid circular dependencies

## TypeScript Standards

### Type Safety
- Enable strict mode in tsconfig.json
- Avoid `any` - use `unknown` when type is truly unknown
- Define explicit return types for public functions
- Use const assertions for literal types

### Naming Conventions
- **Files**: kebab-case (e.g., `database-connection.ts`)
- **Classes**: PascalCase (e.g., `MaterializeStreamer`)
- **Interfaces**: PascalCase with descriptive names (avoid `I` prefix)
- **Functions/Variables**: camelCase
- **Constants**: UPPER_SNAKE_CASE for true constants, camelCase for configuration
- **Private members**: No underscore prefix (use TypeScript `private`)

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
- HTTP servers (Express, Fastify, Koa)
- Database clients (official drivers)
- Validation (Zod, Joi, Yup)
- Date/time manipulation (date-fns, dayjs)
- Logging (Pino, Winston)
- Testing (Vitest, Jest)
- Async utilities (p-queue, rxjs)
- File parsing (yaml, csv-parse)

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

### Principles
- Fail fast with clear error messages
- Include context in errors (what failed, why, what to do)
- Use custom error classes for domain-specific errors
- Log errors at the boundary, not throughout the stack

### Example
```typescript
class ConfigError extends Error {
  constructor(message: string, public field: string) {
    super(`Configuration error in ${field}: ${message}`);
    this.name = 'ConfigError';
  }
}
```

## Testing Standards

### Test Structure
- Use descriptive test names that explain the scenario
- Follow Arrange-Act-Assert pattern
- One assertion per test when possible
- Use test utilities to reduce duplication

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