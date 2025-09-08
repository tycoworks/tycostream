# Workflow State Machines

## Overview

This document explores the design of workflow state machines in tycostream as a way to model well-defined states and transitions in real-time systems. Rather than implementing ad-hoc state tracking, workflows provide a centralized definition of valid states, allowed transitions, and the events that drive state changes.

## Motivation

### The Need for State Management in Real-Time Systems

In real-time streaming systems, events cause state changes. Having well-defined definitions of:
- What constitutes an event
- What states exist in the system
- What transitions are allowed
- What conditions trigger those transitions

...is crucial for building reliable, understandable applications.

### Current Approaches and Their Limitations

Today, developers might implement state tracking in several ways:

1. **Multiple Subscriptions**: Open different subscriptions with various filters to detect state changes
2. **Database-Side Logic**: Implement state enums and transition logic in Materialize
3. **Application-Side State Machines**: Track state entirely in the application layer
4. **Binary Triggers**: Use tycostream's trigger functionality as a proxy for state

While these approaches work, they have limitations:
- **Lack of Centralization**: State definitions scattered across systems
- **No Transition Validation**: Easy to create invalid state transitions
- **Missing Event Semantics**: Hard to reason about what caused a state change
- **Binary Limitations**: Triggers only support fire/clear, not multi-state workflows

### Example Use Case

Consider an order management system with states: `new`, `partially_filled`, `filled`, `completed`, `cancelled`. The transitions between these states and their validity should be centrally defined and enforced, even though different applications may react differently to these state changes.

## Design Approach

### Static Definition, Dynamic Consumption

The key insight is to separate:
1. **State/Transition Definition** (static, centralized)
2. **State Consumption** (dynamic, application-specific)

### States and Transitions in YAML

Define states and valid transitions statically in the source configuration:

```yaml
sources:
  - name: orders
    table: public.orders
    primary_key: order_id
    
    # Static workflow definition
    workflows:
      order_status:
        field: status  # Synthetic field to generate
        states:
          - new
          - partially_filled
          - filled
          - completed
          - cancelled
        
        transitions:
          - from: new
            to: [partially_filled, filled, cancelled]
          - from: partially_filled
            to: [partially_filled, filled, cancelled]
          - from: filled
            to: [completed, cancelled]
          # completed and cancelled are terminal states
        
        # How to derive current state from row data
        # States are evaluated in order - first match wins (precedence)
        state_derivation:
          cancelled: "cancelled_at IS NOT NULL"  # Highest precedence
          completed: "completed_at IS NOT NULL"
          filled: "filled_quantity = total_quantity AND cancelled_at IS NULL"
          partially_filled: "filled_quantity > 0 AND filled_quantity < total_quantity AND cancelled_at IS NULL"
          new: "filled_quantity = 0 AND cancelled_at IS NULL"  # Lowest precedence
```

### Consuming States via Existing Mechanisms

Applications consume these states using tycostream's existing subscription and trigger mechanisms:

#### Via Subscriptions
```graphql
# Subscribe to completed orders
subscription {
  orders(where: { status: { _eq: "completed" } }) {
    order_id
    status
    filled_quantity
    completed_at
  }
}

# Subscribe to cancelled orders
subscription {
  orders(where: { status: { _eq: "cancelled" } }) {
    order_id
    status
    cancelled_at
  }
}
```

#### Via Triggers
```graphql
mutation {
  create_orders_trigger(
    name: "order_completed_webhook"
    webhook: "https://fulfillment-service/webhook"
    fire: { status: { _eq: "completed" } }
  )
}
```

### Benefits of This Approach

1. **Leverages Last-Mile Filtering**: Multiple subscriptions with different status filters hit tycostream's cache, not Materialize
2. **No New APIs**: Uses existing subscription and trigger mechanisms
3. **Clear Separation**: Static definition of what's valid, dynamic choice of what to monitor
4. **Type Safety**: GraphQL schema includes the status enum from YAML
5. **Transition Validation**: Can optionally validate transitions are legal

## Implementation Details

### Synthetic Field Generation

The workflow system generates a synthetic field (e.g., `status`) based on:
1. Current row data
2. State derivation rules
3. Previous state (for transition validation)

### State Change Detection

When a row update occurs:
1. Evaluate state derivation rules against new row data
2. Determine new state
3. If state changed from previous:
   - Validate transition is allowed (optional)
   - Emit as field change in the update event
4. Downstream views/subscriptions filter on this synthetic field

### GraphQL Schema Generation

The YAML workflow definition generates:
- Enum type for the status field
- Filter expressions in the GraphQL schema
- Documentation of valid transitions

Example generated schema:
```graphql
enum OrderStatus {
  new
  partially_filled
  filled
  completed
  cancelled
}

input OrderBoolExp {
  status: OrderStatusExpression
  # ... other fields
}

input OrderStatusExpression {
  _eq: OrderStatus
  _neq: OrderStatus
  _in: [OrderStatus!]
  _nin: [OrderStatus!]
}
```

## Comparison with Alternative Approaches

### Option 1: Runtime Workflow Definition
Define workflows via GraphQL mutations (like triggers):
- **Pros**: Flexible, no restart needed for changes
- **Cons**: No centralized truth, harder to enforce consistency

### Option 2: Direct State in Materialize
Implement state logic in Materialize views:
- **Pros**: All logic in one place
- **Cons**: Requires Materialize expertise, less flexible for consumption

### Option 3: Application-Side State Machines
Each application tracks its own state:
- **Pros**: Full control per application
- **Cons**: Duplication, inconsistency, no shared understanding

### Chosen Approach: Static Definition + Dynamic Consumption
- **Pros**: Central truth, flexible consumption, leverages existing APIs
- **Cons**: Requires restart for workflow changes

## Advanced Features (Future)

### Transition Events

In addition to state-based subscriptions, emit explicit transition events:

```graphql
subscription {
  order_transitions(
    from: "new"
    to: "cancelled"
  ) {
    order_id
    previous_state
    current_state
    transition_timestamp
  }
}
```

### Time-Based Transitions

Support escalations and SLAs:
```yaml
transitions:
  - from: new
    to: escalated
    after: 5m  # Escalate if order stays new for 5 minutes
```

### Composite States

Support hierarchical state machines:
```yaml
states:
  active:
    substates: [new, partially_filled, filled]
  terminal:
    substates: [completed, cancelled]
```

## Migration Path

### From Binary Triggers

Current binary triggers can be modeled as two-state workflows:
```yaml
workflows:
  risk_level:
    states: [normal, breached]
    state_derivation:
      normal: "position_value <= 10000"
      breached: "position_value > 10000"
```

### Incremental Adoption

1. Start with simple state enums in YAML
2. Add transition validation later
3. Implement transition events as needed

## Conclusion

Workflow state machines provide a clean way to model states and transitions in streaming systems. By defining states statically in YAML and consuming them dynamically via existing subscriptions and triggers, we get:

1. **Central source of truth** for valid states and transitions
2. **Flexible consumption patterns** via existing APIs
3. **Efficient implementation** leveraging last-mile filtering
4. **Clear semantics** for state-driven applications

This approach fits naturally with tycostream's architecture while providing the structure needed for complex state management in real-time systems.