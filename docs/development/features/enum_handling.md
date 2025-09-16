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

### YAML Configuration

Users define enum types globally, then reference them in columns (matching PostgreSQL's model):

```yaml
enums:  # Global enum definitions
  order_status: [pending, processing, shipped, delivered, cancelled]
  priority_level: [low, medium, high, critical]
  trade_side: [buy, sell]

sources:
  orders:
    primary_key: order_id
    columns:
      order_id: integer
      customer_id: integer
      status: order_status      # References global enum
      priority: priority_level  # References global enum

  order_history:
    primary_key: id
    columns:
      id: integer
      status: order_status  # Same enum as orders table
      notes: text

  trades:
    primary_key: trade_id
    columns:
      trade_id: integer
      instrument_id: integer
      side: trade_side  # References global enum
      quantity: integer
      price: numeric
```

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

## Implementation Plan

### Step 1: YAML Configuration

**Goal**: Parse global enum definitions and column references from YAML

**Changes**:
1. Extend `src/config/source.types.ts`:
   ```typescript
   interface SourceField {
     name: string;
     type: string;  // PostgreSQL type or enum name
   }

   interface SourceDefinition {
     name: string;
     primaryKeyField: string;
     fields: SourceField[];
   }

   interface YamlSourcesFile {
     enums?: Record<string, string[]>;  // Global enum definitions
     sources: Record<string, YamlSourceConfig>;
   }
   ```

2. Update `src/config/sources.config.ts`:
   - Parse global `enums` section
   - Validate that enum references in columns exist in global enums
   - Pass enum definitions through to schema generation

**Testable**: Config loads with enum definitions

---

### Step 2: GraphQL Enum Generation

**Goal**: Generate GraphQL enum types and comparisons

**Changes**:
1. Update `src/api/schema.ts`:
   - Add `buildEnumTypes()` function to generate enum types
   - Add `buildEnumComparisonTypes()` for comparison inputs
   - Modify `buildFieldDefinitions()` to use enum types
   - Update `buildExpressionInputTypes()` to use enum comparisons

2. Create enum type mapping in `src/common/types.ts`:
   - Add `isEnumType()` helper
   - Update `getGraphQLType()` to handle enums

**Testable**: GraphQL introspection shows enum types and comparisons

---

### Step 3: Runtime Data Handling

**Goal**: Handle enum values through the data pipeline

**Changes**:
1. Update `src/database/materialize.ts`:
   - ParseValue handles enum columns as strings
   - No special parsing needed (PostgreSQL sends enums as text)

2. Verify `src/common/expressions.ts`:
   - Enum comparisons work with existing expression evaluator
   - Enums compare as strings at runtime

**Testable**: Subscriptions filter correctly on enum values

---

### Step 4: Testing

**Goal**: Comprehensive test coverage

**Changes**:
1. Create `test/enum-schema.yaml` with enum examples
2. Add integration tests for:
   - Enum filtering in subscriptions
   - Multiple enum comparisons
   - Null handling for optional enums
3. Test GraphQL type generation

**Testable**: All enum operations work end-to-end

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