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


## Implementation Status

### ✅ Phase 1: Core Enum Support (COMPLETED)
1. **YAML Configuration** - Enums parsed from global definitions
2. **GraphQL Schema Generation** - Proper enum types and comparison inputs
3. **Database Parsing** - Materialize protocol handler parses enum strings correctly

### ✅ Phase 1.5: Revert Integer Storage (COMPLETED)
**Status**: Completed
**Scope**: Reverted integer storage implementation
- ✅ Removed integer conversion in `materialize.ts` parser
- ✅ Changed `DataType.Integer` back to `DataType.String` for enum fields in `sources.config.ts`
- ✅ Removed FieldTransformer code from resolver
- ✅ Reverted test changes expecting integers
**Note**: Successfully reverted to clean string storage throughout

### ✅ Phase 2: Expression Optimization (COMPLETED)

#### 2.1 Enum-Aware Expression Compilation
**Status**: Completed
**Scope**: Expression compiler now optimizes enum comparisons
- ✅ Created ExpressionBuilder class that takes SourceDefinition
- ✅ Detects enum fields and generates optimized ternary chains for ordinal comparisons
- ✅ Generates direct equality checks for _eq, _neq
- ✅ Optimizes to direct boolean expressions where possible
- ✅ **Tests**: Unit tests verify expression generation with enums

#### 2.2 Refactoring for Clean Architecture
**Status**: Completed
**Scope**: Pass SourceDefinition directly to services
- ✅ Refactored SubscriptionService to receive SourceDefinition from resolver
- ✅ Refactored TriggerService to receive SourceDefinition from resolver
- ✅ Eliminated redundant source lookups in services
- ✅ Consolidated service initialization logging

### 📝 Phase 3: Validation & Documentation

#### 3.1 Integration Tests
**Status**: ✅ Completed
**Scope**: End-to-end enum functionality
- ✅ Test enum filtering with WHERE clauses (rank >= silver)
- ✅ Test enum ordering (_gte comparisons work correctly)
- ✅ Test that bronze rank users are filtered out
- ✅ Test combined conditions (active AND rank >= silver)

#### 3.2 Stress Tests
**Status**: 🚧 In Progress
**Scope**: Performance validation
- High-frequency updates with enum transformations
- Multiple concurrent subscriptions with enum filters
- Large enum value sets (50+ values)
- Memory/CPU profiling of transformation overhead

#### 3.3 Demo Update
**Status**: Not Started
**Scope**: Showcase enum capabilities
- Add trade_side or order_status enum to demo schema
- Show type-safe filtering by enum values
- Demonstrate ordinal comparisons
- Compare performance vs string comparisons

#### 3.4 Schema Generator Script Update
**Status**: Not Started
**Scope**: Update generate-schema.sh to support manual enum specification
- Accept enum definitions via CLI flags like `-e status[pending,processing,shipped,delivered]`
- Generate `enums:` section at top of YAML output when enums are specified
- Map specified columns to their enum type names instead of String
- Example usage: `./generate-schema.sh -s orders -p id -e status[pending,processing,shipped]`
**Note**: Automatic detection not possible since Materialize doesn't support native PostgreSQL enum types

#### 3.5 Documentation
**Status**: Not Started
**Scope**: Update user-facing documentation
- Add enum usage to main README
- Document YAML enum syntax
- Show GraphQL query examples with enums
- Explain ordinal comparison behavior

### 📊 Progress Summary

| Component | Status | Priority | Tests |
|-----------|--------|----------|-------|
| Core Enum Support | ✅ Complete | - | ✅ Unit |
| String Storage | ✅ Complete | - | ✅ Unit |
| Revert Integer Storage | ✅ Complete | - | ✅ Verified |
| Expression Optimization | ✅ Complete | - | ✅ Unit |
| Integration Tests | ✅ Complete | - | ✅ E2E |
| Stress Tests | 🚧 In Progress | HIGH | ❌ None |
| Schema Generator Script | ❌ Not Started | HIGH | ❌ None |
| Demo | ❌ Not Started | MEDIUM | N/A |
| Documentation | ❌ Not Started | MEDIUM | N/A |

**Overall Progress**: ~70% Complete
**Next Steps**:
1. Complete stress test with enum filtering
2. Update generate-schema.sh script to support enums
3. Add enum examples to demo
4. Update README documentation

## Original Implementation Plan

### Step 1: YAML Configuration

**Goal**: Parse global enum definitions and column references from YAML

**Changes**:
1. Extend `src/config/source.types.ts`:
   ```typescript
   interface EnumType {
     name: string;
     values: string[];
   }

   interface SourceField {
     name: string;
     dataType: DataType;      // String for enums
     enumType?: EnumType;     // Present only for enum fields
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
4. Update demo to showcase enum usage:
   - Add order_status enum to demo schema
   - Show enum filtering in demo queries

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