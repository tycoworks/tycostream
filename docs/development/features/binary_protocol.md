# Materialize Binary COPY Protocol Implementation Guide

This document describes the specifics of implementing PostgreSQL binary COPY protocol support for Materialize SUBSCRIBE operations, based on empirical findings.

## Overview

Materialize supports binary format output for SUBSCRIBE operations using:
```sql
COPY (SUBSCRIBE TO table_name ENVELOPE UPSERT (KEY (id))) TO STDOUT WITH (FORMAT BINARY);
```

The binary format follows PostgreSQL's binary COPY protocol but includes Materialize-specific types.

## Key Findings

### 1. pg-copy-streams-binary Limitations and Options

The `pg-copy-streams-binary` library has significant limitations when working with Materialize:

- **Limited type support**: Only supports basic PostgreSQL types (int2, int4, int8, float4, float8, bool, text, varchar, json, jsonb, timestamptz)
- **No custom type support**: Cannot handle Materialize-specific types like `mz_timestamp`
- **No numeric type support**: PostgreSQL's `numeric` type is not supported
- **Inflexible type mapping**: Cannot extend or customize type handlers

**Options**:

1. **Fork and extend pg-copy-streams-binary** (Recommended if long-term maintenance is feasible)
   - Add support for numeric type decoding
   - Add plugin system for custom types (mz_timestamp)
   - Extend type mapping to handle all PostgreSQL types
   - Benefits: Cleaner integration, potential to contribute back upstream
   - Drawbacks: Maintenance burden, need to track upstream changes

2. **Create custom binary decoder** (Implemented in current solution)
   - Full control over implementation
   - Can optimize specifically for Materialize use cases
   - No external dependency maintenance
   - Drawbacks: More code to maintain, reimplementing existing functionality

**Current choice**: Custom binary decoder was implemented due to immediate needs and uncertainty about mz_timestamp format.

### 2. Materialize-Specific Column Order

SUBSCRIBE always returns columns in this order:
1. `mz_timestamp` (Materialize's internal timestamp)
2. `mz_state` (operation type: 'upsert', 'delete', 'key_violation')
3. Key columns (in order specified in ENVELOPE UPSERT KEY)
4. Non-key columns (in schema order)

### 3. Type Mappings

When implementing binary decoding, use these type mappings:

```
PostgreSQL Type -> Binary Format Type
integer         -> int4
bigint          -> int8 (decode as string for GraphQL compatibility)
smallint        -> int2
double precision-> float8
real            -> float4
numeric         -> numeric (requires custom decoder)
decimal         -> numeric (same as numeric)
timestamp       -> timestamp (custom decoder)
timestamptz     -> timestamptz
boolean         -> bool
text            -> text
varchar         -> varchar
json            -> json
jsonb           -> jsonb
```

### 4. mz_timestamp Binary Format

The `mz_timestamp` type appears in two formats:
- **18 bytes**: Standard format (most common)
- **16 bytes**: Alternative format (occasionally seen)

Decoding strategy (empirical):
- For 18-byte format: Skip first 10 bytes, read last 8 bytes as BigInt64BE
- For 16-byte format: Try reading last 8 bytes as BigInt64BE
- The value represents milliseconds since Unix epoch

**Note**: Official documentation for mz_timestamp binary format is not available. This is based on observation.

### 5. mz_state Type

In binary format, `mz_state` is transmitted as TEXT, not as an integer:
- Values: 'upsert', 'delete', 'key_violation'
- Do NOT attempt to decode as int8

### 6. PostgreSQL Numeric Type Decoding

The numeric type uses PostgreSQL's complex binary format:

```
Header (8 bytes):
- ndigits (2 bytes): number of digit groups
- weight (2 bytes): weight of first digit group
- sign (2 bytes): 0x0000 = positive, 0x4000 = negative
- dscale (2 bytes): digits after decimal point

Followed by ndigits * 2 bytes of digit data (base 10000)
```

Key insight for decimal placement:
- Weight 0 means the first digit group is in the ones place
- Decimal position = (first digit actual length) + (weight * 4)
- Each digit group represents 4 decimal places (10000 = 10^4)

### 7. BigInt Handling

- PostgreSQL int8 (bigint) values must be converted to strings for GraphQL compatibility
- JSON.stringify() cannot serialize BigInt - use custom replacer
- mz_timestamp returns BigInt values that need special handling in logs

### 8. Binary COPY Protocol Structure

PostgreSQL binary COPY format:
1. Header: 11 bytes magic sequence (PGCOPY\n\xff\r\n\0) + 8 bytes flags/extensions
2. Each row:
   - Field count (2 bytes, int16BE)
   - For each field:
     - Field length (4 bytes, int32BE, -1 for NULL)
     - Field data (variable length)
3. Trailer: Field count = -1 (2 bytes)

### 9. Implementation Requirements

To successfully decode Materialize binary data:

1. **Create custom decoder**: Implement a Transform stream that parses PostgreSQL binary COPY format
2. **Handle all field types**: Including numeric, mz_timestamp, and standard PostgreSQL types
3. **Convert types appropriately**: 
   - int8 -> string (for GraphQL)
   - numeric -> number (with proper decimal handling)
   - mz_timestamp -> BigInt
4. **Handle NULL values**: Field length = -1 indicates NULL
5. **Process row operations**: Use mz_state to determine INSERT/UPDATE/DELETE

### 10. Testing Binary Protocol

To verify binary protocol implementation:

```sql
-- Check column types
\d table_name

-- Test binary output
COPY (SUBSCRIBE TO table_name ENVELOPE UPSERT (KEY (id))) TO STDOUT WITH (FORMAT BINARY);

-- Compare with text output
COPY (SUBSCRIBE TO table_name ENVELOPE UPSERT (KEY (id))) TO STDOUT;
```

### 11. Known Issues and Workarounds

1. **Variable mz_timestamp length**: Handle both 16 and 18 byte formats
2. **Numeric precision**: JavaScript's number type may lose precision for very large numeric values
3. **Binary data in logs**: Use custom replacer to show Buffer(length) instead of raw data
4. **BigInt serialization**: Always convert to string before JSON operations

## Summary

Implementing binary protocol support for Materialize requires:
1. Custom binary COPY decoder (pg-copy-streams-binary is insufficient)
2. Special handling for mz_timestamp and numeric types
3. Proper type conversions for GraphQL compatibility
4. Careful attention to column ordering and NULL handling

The binary protocol offers better performance than text format but requires significantly more implementation complexity.