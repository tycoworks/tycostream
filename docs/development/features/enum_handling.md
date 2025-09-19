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

Users define enum types globally with explicit storage format, then reference them in columns.

#### Enum Definition
All enums must explicitly specify their storage format:

```yaml
enums:
  # Value storage - database sends actual string values
  order_status:
    values: [pending, processing, shipped, delivered, cancelled]
    storage: value  # Database sends 'pending', 'processing', etc.

  # Ordinal storage - database sends position indices
  trade_side:
    values: [buy, sell]
    storage: ordinal  # Database sends 0 for 'buy', 1 for 'sell'

sources:
  orders:
    columns:
      status: order_status  # Storage format already defined at enum level

  trades:
    columns:
      side: trade_side  # Storage format already defined at enum level
```

#### Storage Formats

**`storage: value`** - Database sends the actual enum value as a string
```sql
-- Materialize sends 'buy' or 'sell'
SELECT trade_id, side FROM trades;
```

**`storage: ordinal`** - Database sends the ordinal position as an integer (0-based)
```sql
-- Materialize sends 0 or 1
CREATE MATERIALIZED VIEW trades AS
SELECT
  trade_id,
  CASE side
    WHEN 'buy' THEN 0
    WHEN 'sell' THEN 1
  END as side
FROM upstream_trades;
```

No default is provided - users must be explicit about what their database sends.

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

### ⚠️ Phase 1.5: Revert Integer Storage (REQUIRED)
**Status**: Required before proceeding
**Scope**: Undo the integer storage implementation
- Remove integer conversion in `materialize.ts` parser
- Change `DataType.Integer` back to `DataType.String` for enum fields in `sources.config.ts`
- Remove FieldTransformer code from resolver
- Revert any test changes expecting integers
**Note**: This was an implementation detour - we initially stored enums as integers for performance but realized string storage with expression optimization is cleaner

### 🚧 Phase 2: Expression Optimization (NEXT)

#### 2.1 Enum-Aware Expression Compilation
**Status**: Next Priority
**Scope**: Make expression compiler optimize enum comparisons
- Detect enum fields in expression builder
- Generate ternary chains for ordinal comparisons (_gt, _lt, etc.)
- Generate direct equality checks for _eq, _neq
- Optimize to direct boolean expressions where possible
- **Tests**: Unit tests for expression generation with enums

#### 2.2 Storage Format Support
**Status**: Future Enhancement
**Scope**: Support both ordinal and value storage from Materialize
- Extend YAML enum definitions with `storage: ordinal/value`
- Update parser to handle ordinal values when `storage: ordinal`
- Add validation for ordinal range checking
- **Tests**: Unit tests for both storage formats
- **Note**: Currently only `storage: value` is supported and working

### 📝 Phase 3: Validation & Documentation

#### 3.1 Integration Tests
**Status**: Not Started
**Scope**: End-to-end enum functionality
- Test enum filtering with WHERE clauses
- Test enum ordering (_gt, _lt comparisons)
- Test mixed storage formats (some int, some string)
- Test null handling for optional enums

#### 3.2 Stress Tests
**Status**: Not Started
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

### 📊 Progress Summary

| Component | Status | Priority | Tests |
|-----------|--------|----------|-------|
| Core Enum Support | ✅ Complete | - | ✅ Unit |
| String Storage | ✅ Complete | - | ✅ Unit |
| Revert Integer Storage | ⚠️ Required | IMMEDIATE | - |
| Expression Optimization | ❌ Not Started | HIGH | ❌ None |
| Integration Tests | ❌ Not Started | HIGH | ❌ None |
| Ordinal Storage (`storage: ordinal`) | ❌ Not Started | LOW | ❌ None |
| Stress Tests | ❌ Not Started | MEDIUM | ❌ None |
| Demo | ❌ Not Started | MEDIUM | N/A |

**Overall Progress**: ~30% Complete
**Next Step**: Revert integer storage changes, then implement expression optimization

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