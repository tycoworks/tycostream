# Type System

## Overview

This document describes tycostream's internal type system that maintains semantic type distinctions across layers. By introducing our own type system, we achieve better separation of concerns and maintain type fidelity that would be lost through generic language types.

## Motivation

Currently, tycostream's configuration layer defines mappings from PostgreSQL types directly to GraphQL types, creating tight coupling between layers. This causes several problems:

1. **Layer Coupling**: The config layer needs knowledge of both PostgreSQL and GraphQL type systems, violating separation of concerns
2. **Wrong Abstraction**: Using PostgreSQL types as the common vocabulary between layers ties us to database implementation details
3. **Difficult Testing**: Testing requires mocking both database and GraphQL layers
4. **Limited Extensibility**: Adding new type mappings requires changes across multiple layers
5. **Poor Developer Experience**: Developers must remember PostgreSQL-specific type names like `timestamp without time zone`

## Design

### Core Type System

We introduce a semantic type system that preserves type distinctions needed for correct behavior:

```typescript
// src/common/field-types.ts
export enum DataType {
  // Numeric types
  Integer,      // int2, int4 → GraphQLInt
  Float,        // float4, float8, numeric → GraphQLFloat
  BigInt,       // int8 → GraphQLString (preserve precision)

  // String types
  String,       // text, varchar, etc. → GraphQLString
  UUID,         // uuid → GraphQLID

  // Temporal types
  Timestamp,    // timestamp, timestamptz → GraphQLString
  Date,         // date → GraphQLString
  Time,         // time, timetz → GraphQLString

  // Other types
  Boolean,      // bool → GraphQLBoolean
  JSON,         // json, jsonb → GraphQLString
  Array,        // array types → GraphQLString

  // Special
  Enum,         // User-defined enums → Custom GraphQL enum
}

export enum FieldType {
  Scalar,       // Regular data types
  Enum          // User-defined enumerations
}
```

### Architecture

Each layer owns its specific expertise:

1. **Configuration Layer** (`src/config/`)
   - Validates type names exist
   - Maps field names to DataTypes
   - No knowledge of PostgreSQL OIDs or GraphQL types

2. **Database Layer** (`src/database/`)
   - Maps PostgreSQL types to DataTypes
   - Handles wire protocol parsing using OIDs
   - Owns PostgreSQL-specific logic

3. **GraphQL Layer** (`src/api/`)
   - Maps DataTypes to GraphQL types
   - Generates GraphQL schema
   - Owns GraphQL-specific logic

### Layer Responsibilities

```
PostgreSQL Type → [Database Layer] → DataType → [GraphQL Layer] → GraphQL Type
     "integer"  →  getDataType()   → Integer   → getGraphQLType() → GraphQLInt
     "uuid"     →  getDataType()   → UUID      → getGraphQLType() → GraphQLID
```

## Benefits

1. **Type Fidelity**: Semantic distinctions preserved (Float ≠ Integer, UUID ≠ String)
2. **Decoupling**: Each layer only knows about its own type system and DataType
3. **Testability**: Layers can be tested independently
4. **Extensibility**: New types added in one place, mappings in respective layers
5. **Clarity**: DataType enum clearly documents all supported types

## Migration Path

### Current State (PostgreSQL Types in YAML)

```yaml
sources:
  trades:
    columns:
      trade_id: integer
      price: numeric
      executed_at: timestamp without time zone
      side: trade_side  # Enum reference
```

### Future State (DataTypes in YAML)

```yaml
sources:
  trades:
    columns:
      trade_id: Integer
      price: Float
      executed_at: Timestamp
      side: trade_side  # Enum reference unchanged
```

### Migration Benefits

1. **Simpler Configuration**: No need to remember PostgreSQL type names
2. **Database Agnostic**: Could support other databases without changing YAML
3. **Cleaner Validation**: Config only validates against DataType enum
4. **Better Documentation**: DataType names are self-documenting

## Implementation Plan

### Phase 1: Introduce Type System (Current)

**Goal**: Create the type system and use it internally

**Changes**:
1. Create `src/common/field-types.ts` with DataType and FieldType enums
2. Update `src/database/parsing.ts`:
   - Add `getRuntimeType(pgTypeName: string): DataType`
   - Update `parseValue()` to use DataType
3. Update `src/api/types.ts`:
   - Add `getGraphQLScalarType(dataType: DataType)`
4. Update `src/config/sources.config.ts`:
   - Resolve types at config load time
   - Store DataType in SourceField

**Result**: Type system exists but YAML still uses PostgreSQL types

---

### Phase 2: YAML Migration

**Goal**: Use DataTypes in YAML configuration

**Changes**:
1. Update `src/config/sources.config.ts`:
   - Accept both PostgreSQL types and DataTypes (backward compatibility)
   - Prefer DataType when both are valid
2. Create migration tool:
   - Read existing YAML
   - Convert PostgreSQL types to DataTypes
   - Write updated YAML
3. Update documentation and examples

**Result**: Clean YAML using semantic types

---

### Phase 3: Remove PostgreSQL Types from Config

**Goal**: Config layer only knows about DataTypes

**Changes**:
1. Remove PostgreSQL type validation from config
2. Update all YAML files to use DataTypes
3. Remove backward compatibility code
4. Config layer becomes database-agnostic

**Result**: Complete separation of concerns

## Technical Considerations

### Database Introspection

With DataTypes in YAML, we lose direct database introspection capability. Solution:
- Provide introspection tool that generates YAML from database
- Tool maps PostgreSQL types to DataTypes
- Maintains database-first workflow when needed

### Type Extensions

Adding new types:
1. Add to DataType enum
2. Add PostgreSQL → DataType mapping in database layer
3. Add DataType → GraphQL mapping in GraphQL layer
4. Update documentation

### Validation

- Config validates DataType names exist
- Database validates PostgreSQL types are supported
- GraphQL generation always succeeds (all DataTypes have mappings)

## Future Considerations

1. **Composite Types**: Support for nested objects/records
2. **Custom Scalars**: User-defined GraphQL scalars
3. **Type Parameters**: Array element types, numeric precision
4. **Type Constraints**: Length limits, ranges, patterns

## Conclusion

The internal type system provides a clean abstraction between layers while maintaining type fidelity. This architecture supports our immediate needs (enums, calculated states) while providing a foundation for future type system enhancements. The migration path allows incremental adoption without breaking changes.