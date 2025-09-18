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

**Key Decision**: Enums are represented as integers internally for efficient ordinal comparisons, but transmitted as strings over the wire for human readability.

#### Internal vs Wire Representation
- **Internal (Processing)**: `DataType.Integer` - Enums stored as ordinal indices (0, 1, 2...)
- **Wire (GraphQL)**: Strings - Human-readable enum values ('pending', 'processing', etc.)
- **Database**: Strings - PostgreSQL sends enums as text over COPY protocol
- **Identity**: The presence of an `enumType?: EnumType` field distinguishes enum fields
- **Ordering**: Integer representation enables fast ordinal comparisons (_gt, _lt, etc.)

#### Why Integers Internally?
This follows established database patterns:
- PostgreSQL stores enums as OIDs with ordinal positions internally
- MySQL stores enums as integers (1-based indexing)
- Most databases optimize enum comparisons using ordinal values
- Avoids runtime string comparisons in hot paths (filter evaluation)

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

## Transformation Architecture

### Current Implementation: Service-Level Transformation

Enums are currently transformed at the service level:
- **FieldTransformer** class handles bidirectional transformations
- Created in SubscriptionService and TriggerService
- Applied during expression building and output serialization

### Architectural Options for Wire/Internal Transformations

#### Option 1: Resolver-Level Transformation (GraphQL Boundary)
**Most idiomatic for our dynamic schema generation**

```typescript
// In subscription.resolver.ts
const transformer = new FieldTransformer(sourceDefinition);

// Transform inputs immediately at boundary
const internalWhere = transformer.transformExpression(args.where);

// Transform outputs just before sending
return service.createSubscription(source, internalWhere).pipe(
  map(data => transformer.recordToWire(data))
);
```

**Pros:**
- Clear separation: All transformations at API boundary
- Services work purely with internal representations
- Single responsibility for each layer

**Cons:**
- Requires modifying resolver generation code
- Need to pass transformer through multiple layers

#### Option 2: NestJS Interceptor (AOP Style)
**Most idiomatic for NestJS**

```typescript
@Injectable()
export class EnumTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const args = context.getArgs();
    // Transform inputs
    if (args.where) {
      args.where = this.transformer.transformExpression(args.where);
    }

    return next.handle().pipe(
      // Transform outputs
      map(data => this.transformer.recordToWire(data))
    );
  }
}
```

**Pros:**
- Aspect-oriented: Transformation logic completely separate
- Reusable across all resolvers
- Very NestJS-idiomatic

**Cons:**
- Less explicit about what's happening
- Harder to debug transformation issues
- Would need per-source configuration

#### Option 3: Custom GraphQL Scalars
**Most idiomatic for GraphQL**

```typescript
@Scalar('TradeStatus')
export class TradeStatusScalar implements CustomScalar<string, number> {
  parseValue(value: string): number {
    return this.enumValues.indexOf(value);
  }

  serialize(value: number): string {
    return this.enumValues[value];
  }
}
```

**Pros:**
- GraphQL-native approach
- Type safety at GraphQL layer
- Clear in schema what's happening

**Cons:**
- Requires generating custom scalars per enum
- Doesn't work well with our dynamic schema generation
- More complex for expression trees

#### Option 4: Service Wrapper/Conduit
**Cleanest separation of concerns**

```typescript
class TransformedSubscriptionService {
  constructor(
    private service: SubscriptionService,
    private transformer: FieldTransformer
  ) {}

  createSubscription(source: string, where: ExpressionTree) {
    const internalWhere = this.transformer.transformExpression(where);
    return this.service.createSubscription(source, internalWhere).pipe(
      map(data => this.transformer.recordToWire(data))
    );
  }
}
```

**Pros:**
- Complete separation of transformation from business logic
- Easy to test in isolation
- Services remain pure

**Cons:**
- Additional layer of abstraction
- Need wrapper for each service

### Recommendation

**For tycostream**: Option 1 (Resolver-Level) is recommended because:
1. Our schema is dynamically generated, making static approaches difficult
2. Clear boundary between wire and internal representations
3. Transformations happen at the earliest/latest possible points
4. Consistent with treating this as serialization/deserialization

The transformation should happen:
- **Inbound**: Immediately upon receiving GraphQL arguments
- **Outbound**: Just before returning GraphQL responses

This treats FieldTransformer as a codec at the API boundary, which is conceptually clean.

## Implementation Status

### ✅ Phase 1: Core Enum Support (COMPLETED)
1. **YAML Configuration** - Enums parsed from global definitions
2. **GraphQL Schema Generation** - Proper enum types and comparison inputs
3. **Internal Representation** - Enums stored as integers (ordinal indices)
4. **Database String Parsing** - Materialize protocol handler converts strings to indices
5. **Expression Compilation** - Enum comparisons work with ordinal semantics

### 🚧 Phase 2: Serialization Layer (IN PROGRESS)

#### 2.1 Resolver-Level Transformation
**Status**: Next Priority
**Scope**: Implement transformations at GraphQL boundary
- Implement FieldTransformer at resolver generation
- Transform expressions on input (string → int)
- Transform data on output (int → string)
- Keep services working with internal representation only
- **Tests**: Unit tests for bidirectional transformations

#### 2.2 Storage Format Support
**Status**: Not Started (Lower Priority)
**Scope**: Support both ordinal and value storage from Materialize
- Extend YAML enum definitions with `storage: ordinal/value`
- Update parser to handle ordinal values without conversion
- Add validation for ordinal range checking
- **Tests**: Unit tests for both storage formats
- **Note**: Currently only `storage: value` is supported

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
| Value Storage (`storage: value`) | ✅ Complete | - | ✅ Unit |
| Resolver Transform | 🚧 Next | HIGH | ❌ None |
| Integration Tests | ❌ Not Started | HIGH | ❌ None |
| Ordinal Storage (`storage: ordinal`) | ❌ Not Started | LOW | ❌ None |
| Stress Tests | ❌ Not Started | MEDIUM | ❌ None |
| Demo | ❌ Not Started | MEDIUM | N/A |

**Overall Progress**: ~35% Complete
**Next Step**: Implement resolver-level transformations

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