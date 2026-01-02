# Enum Handling

## Overview

This document describes the design for first-class enum support in tycostream. Enums are a common PostgreSQL data type that should be represented as proper GraphQL enums with type-safe comparisons, not just strings. This provides better developer experience and type safety throughout the stack.

## Motivation

Currently, PostgreSQL enum columns are treated as text fields in tycostream, losing type information and safety. Applications using enums need:

1. **Type Safety**: Proper GraphQL enum types instead of strings
2. **Filtering Support**: Type-safe enum comparisons in GraphQL subscriptions
3. **Developer Experience**: IntelliSense/autocomplete for valid enum values
4. **Consistency**: Same handling for both persisted and calculated enums (future)

## Design

### Design Decision: Enum Representation

**Key Decision**: Enums are stored and transmitted as strings throughout the system, with optimized expression compilation for ordinal comparisons.

#### Unified String Representation
- **Storage**: Enums stored as strings matching their GraphQL representation
- **Database**: PostgreSQL sends enums as text over COPY protocol - we preserve this
- **GraphQL**: Direct string values with no transformation needed
- **Identity**: The presence of an `enumType?: EnumType` field distinguishes enum fields
- **Ordering**: Expression compiler generates optimized code for ordinal comparisons

#### Expression Optimization for Ordinal Comparisons
While enums are strings throughout the system, ordinal comparisons (_gt, _lt, etc.) are handled efficiently through compile-time optimization in the expression builder:

```javascript
// For { status: { _gt: 'pending' } } with enum [pending, processing, shipped]
// Instead of runtime indexOf calls, we generate:
"(datum.status === 'pending' ? 0 : datum.status === 'processing' ? 1 : datum.status === 'shipped' ? 2 : -1) > 0"

// Or even better, for small enums we can optimize to direct checks:
"(datum.status === 'processing' || datum.status === 'shipped')"
```

This approach:
- **No allocations**: No arrays or objects created during evaluation
- **No transformations**: Data stays as strings throughout
- **Fast comparisons**: Ternary chains are optimized by JavaScript JIT compilers
- **Simple data flow**: What you see in logs is what's in the system

### YAML Configuration

Users define enum types globally, then reference them in columns.

#### Enum Definition

```yaml
enums:
  order_status:
    - pending
    - processing
    - shipped
    - delivered
    - cancelled

  trade_side:
    - buy
    - sell

sources:
  orders:
    columns:
      status: order_status  # References the global enum

  trades:
    columns:
      side: trade_side  # References the global enum
```

The database always sends enum values as their string representation. Materialize and PostgreSQL both transmit enums as text over the COPY protocol.

### Enum Ordering and Comparisons

The order of enum values in the array defines their precedence and comparison semantics:
- First value has the lowest precedence (0)
- Last value has the highest precedence (n-1)
- Comparisons use this ordering for `_gt`, `_gte`, `_lt`, `_lte` operators

For example, with `order_status: [pending, processing, shipped, delivered, cancelled]`:
- `pending` < `processing` < `shipped` < `delivered` < `cancelled`
- `{ status: { _gt: shipped } }` matches `delivered` and `cancelled`
- `{ status: { _lte: processing } }` matches `pending` and `processing`

This ordering is consistent with calculated states where the last value has highest precedence.

### GraphQL Schema Generation

From the YAML configuration, tycostream generates:

#### Enum Types
```graphql
enum order_status {
  pending
  processing
  shipped
  delivered
  cancelled
}

enum priority_level {
  low
  medium
  high
  critical
}

enum trade_side {
  buy
  sell
}
```

#### Enum Comparison Types
```graphql
input order_statusComparison {
  _eq: order_status
  _neq: order_status
  _gt: order_status   # Based on array order
  _gte: order_status
  _lt: order_status
  _lte: order_status
  _in: [order_status!]
  _nin: [order_status!]
  _is_null: Boolean
}

input priority_levelComparison {
  _eq: priority_level
  _neq: priority_level
  _gt: priority_level   # Based on array order
  _gte: priority_level
  _lt: priority_level
  _lte: priority_level
  _in: [priority_level!]
  _nin: [priority_level!]
  _is_null: Boolean
}
```

#### Object Types with Enums
```graphql
type orders {
  order_id: Int!
  customer_id: Int
  status: order_status      # References global enum
  priority: priority_level  # References global enum
}

type order_history {
  id: Int!
  status: order_status  # Same enum as orders
  notes: String
}
```

#### Expression Types with Enum Comparisons
```graphql
input ordersExpression {
  order_id: IntComparison
  customer_id: IntComparison
  status: order_statusComparison      # Type-safe enum comparison
  priority: priority_levelComparison  # Type-safe enum comparison
  _and: [ordersExpression!]
  _or: [ordersExpression!]
  _not: ordersExpression
}
```

### Usage Example

With proper enum support, developers can write type-safe subscriptions:

```graphql
subscription HighPriorityOrders {
  orders(
    where: {
      priority: { _in: [high, critical] }  # Type-safe enum values
      status: { _neq: cancelled }
    }
  ) {
    operation
    data {
      order_id
      status  # Returns OrdersStatus enum
      priority  # Returns OrdersPriority enum
    }
  }
}
```

## Benefits

1. **Type Safety**: Compile-time checking of enum values in GraphQL
2. **Developer Experience**: IDE autocomplete for enum values
3. **Self-Documenting**: GraphQL schema clearly shows valid values
4. **Consistency**: Foundation for calculated enums (same infrastructure)
5. **Filtering**: Type-safe enum comparisons in subscriptions


## Implementation

### Phase 1: Core Enum Support

**YAML Configuration** - Parse global enum definitions and column references from YAML. Enums are defined globally and referenced by columns.

**GraphQL Schema Generation** - Generate proper GraphQL enum types and comparison input types. Each enum gets its own type and comparison operators.

**Database Parsing** - Materialize protocol handler parses enum values as strings, no special conversion needed.

### Phase 2: Expression Optimization

**Enum-Aware Expression Compilation** - Create ExpressionBuilder class that takes SourceDefinition and generates optimized code for enum comparisons. Instead of runtime indexOf calls, generate ternary chains or direct boolean expressions.

**Clean Architecture** - Refactor services to receive SourceDefinition directly from resolvers, eliminating redundant source lookups and improving performance.

### Phase 3: Schema Generator Support

**Command-Line Interface** - Extend generate-schema.sh with:
- `-e` flag for defining enums: `-e side "buy,sell"`
- `-c` flag for column mapping: `-c side:side`
- Generates `enums:` section at top of YAML output
- Works with both tables and materialized views

Example:
```bash
./generate-schema.sh \
  -e side "buy,sell" \
  -e event_type "FIRE,CLEAR" \
  -s live_pnl -p instrument_id \
  -s trades -p id -c side:side \
  -s alerts -p id -c event_type:event_type
```

Note: Manual specification required since Materialize doesn't support native PostgreSQL enum types.

## Testing

**Unit Tests**:
- `src/config/sources.config.spec.ts` - Enum parsing from YAML
- `src/api/schema.spec.ts` - GraphQL enum type generation
- `src/api/expressions.spec.ts` - Enum-aware expression compilation
- `src/database/materialize.spec.ts` - Enum value parsing
- `src/view/view.spec.ts` - Enum field handling

**Integration Tests**:
- `test/integration.e2e-spec.ts` - End-to-end enum filtering with `rank` enum
- `test/stress-test.e2e-spec.ts` - Performance testing with `status` and `department` enums


## Technical Considerations

### PostgreSQL Representation
- PostgreSQL enums are stored efficiently but transmitted as text over the wire
- No special handling needed in COPY protocol parsing
- Enum values are case-sensitive strings

### GraphQL Best Practices
- Enum values should be SCREAMING_SNAKE_CASE per GraphQL conventions
- We'll accept any case in YAML and preserve it
- Future: Consider case transformation options

### Performance
- Enum comparisons are string comparisons at runtime
- No performance difference from current string handling
- Type safety is compile-time only

## Future Enhancements

1. **Case Transformation**: Option to transform enum cases (snake_case → SCREAMING_SNAKE_CASE)
2. **Enum Introspection**: Query PostgreSQL pg_enum catalog (optional)
3. **Calculated Enums**: Build on this infrastructure for calculated state enums
4. **Enum Evolution**: Handle enum value additions/removals gracefully

## Conclusion

First-class enum support provides type safety and better developer experience without adding runtime complexity. The implementation is straightforward: parse from YAML, generate GraphQL types, and handle as strings at runtime. This also provides the foundation for calculated enums feature.