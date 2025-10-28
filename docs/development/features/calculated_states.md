# Calculated States

## Overview

This document describes the design of calculated state fields in tycostream. Calculated states are synthetic enum fields that are computed from row data at runtime, providing type-safe state representations without requiring persistence or database changes.

Note: While this document focuses on calculated states (enums), the architecture is designed to support general calculated fields in the future (booleans, numbers, strings). The key principle is that field types are defined statically for type safety, while evaluation logic is always provided at runtime.

## Motivation

There are two key motivations for implementing calculated states:

### 1. Value in Real-Time Systems

Real-time streaming applications often need to categorize data into states based on current values:
- Risk levels based on position values
- Alert statuses based on thresholds
- Performance categories based on metrics

For example, consider a position monitoring system. Rather than each application implementing its own logic to determine if a position is "safe" (< $10k), "warning" ($10k-$50k), or "critical" (> $50k), tycostream can provide this as a calculated state field. Different applications can then use different thresholds while sharing the same state vocabulary.

These states are:
- Calculated from existing data fields
- Application-specific (different apps may have different thresholds)
- Ephemeral (not persisted)
- Best represented as enums for type safety

### 2. Solving the Trigger Connection Problem

tycostream's current trigger implementation uses webhooks for asynchronous callbacks. While this works for centrally-managed cross-application events, it has limitations for application-specific monitoring:

- **No Connection Awareness**: Applications don't know if tycostream is running or if their triggers are still registered
- **Ambiguous Silence**: Can't distinguish between "condition not met" and "system down"
- **Binary States Only**: Triggers only support fire/clear, not multi-state representations

For applications that need to maintain persistent connections and monitor their own calculated states, we need a subscription-based approach with proper state modeling.

## Design

### Types of State

When building streaming applications, there are two types of state:

1. **Persisted State**: States stored in the database (e.g., `order.status`) and managed by transactional systems systems of record
2. **Calculated State**: States derived from other data fields at runtime (e.g., risk levels based on position values)

This document focuses exclusively on calculated states.

### Design Principles

1. **Type Safety First**: All field types must be defined statically for GraphQL type safety
2. **Runtime Evaluation**: All calculation logic is provided at runtime using our existing expression system
3. **No YAML Expressions**: Expressions in YAML strings would lose type safety
4. **Shared Logic Belongs in Materialize**: If all apps need the same calculation, put it in the upstream view in the streaming database

### Design Approaches

For calculated states, there are three possible approaches:

1. **Fully Static**: Define both state enums and evaluation logic in YAML configuration
2. **Fully Dynamic**: Define everything at runtime via GraphQL parameters
3. **Hybrid**: Define state enums statically (compile time), but evaluation logic dynamically (runtime)

**Our Approach**: We choose the hybrid approach because it provides:
- Type safety through static enum definitions
- Flexibility for different applications to use different thresholds
- GraphQL idiomatic design with proper enums
- Connection awareness through subscriptions

### Implementation Design

#### Static Configuration (YAML)

tycostream already supports global enum definitions. Calculated states leverage this by referencing existing enums:

```yaml
enums:
  risk_level: [safe, warning, critical]
  alert_status: [normal, triggered, cleared]

sources:
  positions:
    primary_key: position_id
    columns:
      position_id: integer
      value: double precision
    calculated_fields:
      risk_level: risk_level  # References global enum

  orders:
    primary_key: order_id
    columns:
      order_id: integer
      quantity: integer
    calculated_fields:
      alert_status: alert_status  # References global enum
```


#### Runtime Evaluation

Applications provide evaluation logic when subscribing:

```graphql
# Risk application with conservative thresholds
subscription RiskMonitoring {
  positions(
    derive_risk_level: [
      { state: critical, when: { value: { _gt: 10000 } } }
      { state: warning, when: { value: { _gt: 9500 } } }
      { state: safe, when: { value: { _lte: 9500 } } }
    ]
  ) {
    position_id
    value
    risk_level  # Type-safe risk_level enum
  }
}

# Compliance application with different thresholds
subscription ComplianceMonitoring {
  positions(
    derive_risk_level: [
      { state: critical, when: { value: { _gt: 50000 } } }
      { state: warning, when: { value: { _gt: 40000 } } }
      { state: safe, when: { value: { _lte: 40000 } } }
    ]
  ) {
    position_id
    value
    risk_level  # Same enum, different evaluation
  }
}
```


### Benefits

1. **Runtime Flexibility**: Each application defines its own thresholds
2. **Connection Awareness**: Subscriptions provide connection status
3. **No Logic Duplication**: Evaluation logic stays with the application that needs it
4. **Leverages Caching**: Multiple subscriptions with different evaluations still hit tycostream's cache

## Implementation Details

### Synthetic Field Generation

The calculated state system:
1. Source receives evaluation conditions when creating a subscription stream
2. For each row, Source evaluates conditions using enum ordering
3. Source assigns the matching state
4. Source emits rows with synthetic fields included
5. View applies filtering on the complete row (including calculated fields)

### Event Identity and Deduplication

Each event in the stream includes a unique `eventId` with the format `source:primaryKey:timestamp`. This enables:

**Deduplication**: Clients can track which events they've processed, avoiding duplicate handling on reconnection:
```typescript
const processedEvents = new Set<string>();
subscription.subscribe((event) => {
  if (processedEvents.has(event.eventId)) return; // Skip duplicate
  processedEvents.add(event.eventId);
  // Process state transition
});
```

**Audit Trail**: State transitions can be logged with stable identifiers:
```typescript
if (event.row.risk_level === 'critical') {
  auditLog.write({
    eventId: event.eventId,
    message: `Position ${event.row.position_id} entered critical state`,
    timestamp: new Date()
  });
}
```

**Idempotency**: Multiple subscribers or retries can safely process the same event without side effects, as they can detect when an event has already been handled.

This is particularly valuable for calculated states where state transitions (safe → critical) are business-critical events that applications need to track reliably.

### Integration with Triggers and Views

#### Triggers
Triggers can use calculated state fields in their conditions:

```graphql
mutation {
  create_positions_trigger(
    name: "critical_risk_webhook"
    webhook: "https://risk-service/webhook"
    derive_risk_level: [
      { state: critical, when: { value: { _gt: 10000 } } }
      { state: warning, when: { value: { _gt: 9500 } } }
      { state: safe, when: { value: { _lte: 9500 } } }
    ]
    fire: { risk_level: { _eq: critical } }
  )
}
```

#### Views
The field type is defined at the source level (for GraphQL schema generation), and calculation happens at the source level when creating subscription streams. Views receive rows with calculated fields already evaluated and simply apply filtering. This maintains clean separation: Source provides all data (real and calculated), View filters that data.

## Future Considerations

### General Calculated Fields

While this document focuses on enum states, the architecture supports future expansion to other calculated field types:

```yaml
# Potential future capability
calculated_fields:
  risk_level: risk_level  # Current - references global enum

  is_large_trade:  # Future
    type: boolean

  risk_score:  # Future
    type: number

  alert_message:  # Future
    type: string
```

All would follow the same principle: types defined statically, evaluation logic provided at runtime.

### Why Not Full Calculated Fields Now?

1. **States have unique requirements**: Precedence ordering, enum generation
2. **Clear use case**: Replacing binary triggers with multi-state subscriptions
3. **Expression system limitations**: Current expression system only supports boolean conditions, not arithmetic or string operations
4. **Incremental approach**: Validate the pattern with states first

## Conclusion

Calculated states provide a type-safe way to generate state enums from streaming data. By defining state types statically and evaluation logic dynamically, we achieve:

1. **Type safety** through GraphQL enums
2. **Flexibility** for application-specific thresholds
3. **Connection awareness** through subscriptions
4. **Clear semantics** for state-driven applications

This approach focuses on calculated states as a specific, high-value use case, while architecturally supporting future expansion to general calculated fields.

## Implementation Plan

### Step 1: Configuration Foundation

**Goal**: Parse calculated field references from YAML, leveraging existing enum support

**Changes**:
1. Extend `src/config/source.types.ts`:
   ```typescript
   interface SourceDefinition {
     // ... existing fields ...
     calculatedFields?: Map<string, string>;  // field name → enum name
   }

   interface YamlSourceConfig {
     // ... existing fields ...
     calculated_fields?: Record<string, string>;  // field name → enum name
   }
   ```

2. Update `src/config/sources.config.ts`:
   - Parse `calculated_fields` section
   - Validate that referenced enums exist in global enums
   - Store calculated field → enum mappings

3. Update `src/api/schema.ts`:
   - Include calculated fields in GraphQL object types

**Testable**: GraphQL schema includes calculated fields with correct enum types

**Commit point**: "feat: add calculated field configuration"

---

### Step 2: Static Calculated Fields

**Goal**: Support calculated fields with static evaluation (no runtime params yet)

**Changes**:
1. Add simple field calculation in Source layer (`src/view/source.ts`):
   ```typescript
   // In processUpdate, after getting row from database
   // For testing, hardcode some logic
   if (this.sourceDef.calculatedFields?.get('risk_level')) {
     row.risk_level = row.value > 10000 ? 'critical' : 'safe';
   }
   ```

2. Track calculated fields in RowUpdateEvent.fields Set
3. Basic test with hardcoded logic

**Testable**: Subscription returns calculated field with hardcoded logic

**Commit point**: "feat: add basic calculated field evaluation in source"

---

### Step 3: Runtime Evaluation Parameters

**Goal**: Accept evaluation logic via GraphQL subscription parameters

**Changes**:
1. Extend GraphQL subscription arguments:
   ```graphql
   subscription {
     positions(
       derive_risk_level: [
         { state: critical, when: { value: { _gt: 10000 } } }
         { state: safe, when: { value: { _lte: 10000 } } }
       ]
     )
   }
   ```

2. Parse parameters in subscription resolver and pass to View
3. View passes evaluation logic to Source.getUpdates()
4. Source evaluates conditions in precedence order for each row
5. Remove hardcoded logic from Step 2

**Testable**: Different subscriptions can have different thresholds

**Commit point**: "feat: add runtime evaluation for calculated states"

---

### Step 4: Trigger Integration

**Goal**: Allow triggers to use calculated state fields

**Changes**:
1. Extend trigger mutations to accept derive parameters:
   ```graphql
   create_positions_trigger(
     derive_risk_level: [...]
     fire: { risk_level: { _eq: critical } }
   )
   ```

2. Apply state calculation before trigger evaluation
3. Update trigger tests

**Testable**: Triggers can fire based on calculated states

**Commit point**: "feat: integrate calculated states with triggers"

---

### Step 5: Demo & Polish

**Goal**: Update demo to showcase calculated states

**Changes**:
1. Replace webhook round-trip with calculated states
2. Show positions changing color based on risk_level
3. Performance optimization:
   - Cache evaluation results
   - Only recalculate on relevant field changes
4. Documentation updates

**Testable**: Demo clearly shows value proposition

**Commit point**: "feat: update demo to use calculated states"

---

### Step 6: Reimplement Triggers Internally

**Goal**: Unify triggers around calculated state mechanism

**Changes**:
1. Remove match/unmatch logic from views - Views only filter, don't track state
2. Add synthetic trigger state field internally:
   ```typescript
   calculated_fields: {
     __trigger_state: {
       type: 'enum',
       values: ['cleared', 'fired']
     }
   }
   ```
3. Map fire/clear conditions to state derivation
4. Simplify view logic significantly

**Benefits**: Single unified state evaluation mechanism, simpler codebase

**Commit point**: "refactor: reimplement triggers using calculated states"

---

## Key Implementation Challenges

### 1. Empty Field Problem

**Issue**: If we advertise a field in the schema, consumers expect it in every row.

**Solutions**:
- Always include field with `null` if no state matches
- OR: Only include field when evaluation params provided
- OR: Make calculated fields clearly optional in schema

**Recommendation**: Always include with `null` - cleaner contract

### 2. Source Layer Integration

**Current**: Source emits rows as received from database

**Change needed**: Source needs to evaluate and add calculated fields before emitting

**Approach**:
- Accept evaluation logic in getUpdates()
- Add evaluation step in processUpdate()
- Emit rows with calculated fields included
- Maintain immutability (create new row object)

### 3. Performance

**Concern**: Evaluating conditions on every row update

**Mitigations**:
- Only evaluate if subscription requested it
- Cache results when row hasn't changed
- Use efficient precedence evaluation (first match wins)

### 4. Testing Strategy

**Unit tests**:
- Configuration parsing
- Enum generation
- State evaluation logic

**Integration tests**:
- End-to-end subscription with calculated states
- Multiple subscribers with different thresholds
- Trigger integration

**Performance tests**:
- High-frequency updates with state calculation
- Many calculated fields