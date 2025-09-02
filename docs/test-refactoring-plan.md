# Test Infrastructure Refactoring Plan

## Current State

The existing test infrastructure is subscription-centric with these limitations:

1. **TestClient** 
   - Takes GraphQL query in constructor
   - Only handles subscriptions
   - Tracks expectedState for convergence
   - No support for queries/mutations

2. **TestClientManager**
   - Creates and manages multiple TestClient instances
   - Waits for all clients to converge on expectedState
   - No webhook support

3. **TestEnvironment**
   - Has webhook server support but it's not integrated
   - Provides database and app lifecycle management

## Target State

A unified test infrastructure that supports all GraphQL operations:

### TestClient (Self-Contained)
```typescript
export class TestClient<TData = any> {
  private wsClient: WSClient;
  private httpClient: ApolloClient;
  
  // Subscription tracking
  private currentState = new Map<string | number, TData>();
  private expectedState?: Map<string | number, TData>;
  
  // Webhook tracking
  private expectedWebhooks = new Map<string, any[]>(); // triggerName -> expected events
  private receivedWebhooks = new Map<string, any[]>(); // triggerName -> received events
  private webhookPort: number;
  
  constructor(options: {
    clientId: string;
    appPort: number;
    webhookPort: number;
    livenessTimeoutMs?: number;
  })

  // Subscription method (no longer in constructor)
  async subscribe(options: {
    query: string;
    expectedState: Map<string | number, TData>;
    dataPath: string;
    idField: string;
    onOperation?: (op: string, data: TData) => void;
  }): Promise<void>

  // Query method (synchronous/await-able)
  async query<T>(query: string, variables?: any): Promise<T>

  // Mutation method (synchronous/await-able)
  async mutate<T>(mutation: string, variables?: any): Promise<T>

  // Trigger creation with webhook expectations
  async createTrigger(
    source: string,
    trigger: {
      name: string;
      match: any;
      unmatch?: any;
      expectedWebhooks?: any[];
    }
  ): Promise<void>

  // Webhook handling
  handleWebhook(triggerName: string, payload: any): void
  getWebhooks(triggerName: string): any[]

  // Unified completion checking
  isComplete(): boolean  // Checks both subscriptions AND webhooks
  async waitForCompletion(): Promise<void>
}
```

### TestClientManager (Thin Coordinator)
```typescript
export class TestClientManager {
  private clients: TestClient[] = [];
  private clientMap = new Map<string, TestClient>();
  
  constructor(
    private port: number,
    private livenessTimeoutMs: number,
    private webhookPort: number
  )

  createClient(clientId?: string): TestClient

  // Simple webhook routing based on path structure
  handleWebhook(path: string, payload: any): void

  async waitForCompletion(): Promise<void>
}
```

### TestEnvironment Integration
- Webhook handler routes to TestClientManager
- Manager routes to appropriate TestClient based on URL path
- Path structure: `/webhook/{clientId}/{triggerName}`

## Migration Steps

### Step 1: Move Subscription from Constructor to Method
**Goal**: Constructor only sets up clients, not subscriptions. This prepares for adding other operation types.

**Changes**:
1. Update constructor signature to only take configuration (not subscription details):
   ```typescript
   constructor(options: {
     clientId: string;
     appPort: number;
     livenessTimeoutMs?: number;
     onFinished: () => void;
     onStalled: (clientId: string) => void;
     onRecovered: (clientId: string) => void;
   })
   ```

2. Create `subscribe()` method that takes subscription-specific options:
   ```typescript
   async subscribe(options: {
     query: string;
     expectedState: Map<string | number, TData>;
     dataPath: string;
     idField: string;
     onOperation?: (op: string, data: TData) => void;
   }): Promise<void>
   ```

3. Move subscription logic from constructor and `startSubscription()` to new `subscribe()` method

4. Update TestClientManager.startClient() to create client then call subscribe():
   ```typescript
   async startClient(options: StartClientOptions<TData>): Promise<void> {
     const client = new TestClient({
       clientId,
       appPort: this.port,
       livenessTimeoutMs: this.livenessTimeoutMs,
       onFinished: () => this.onClientFinished(),
       onStalled: (id) => this.onClientStalled(id),
       onRecovered: (id) => this.onClientRecovered(id)
     });
     
     await client.subscribe({
       query: options.query,
       expectedState: options.expectedState,
       dataPath: options.dataPath,
       idField: options.idField,
       onOperation: options.onOperation
     });
     
     this.clients.push(client);
   }
   ```

**Testing**: Update existing tests to call subscribe() after creating client

### Step 2: Add Webhook Support to TestClient
**Goal**: TestClient can track webhook expectations without breaking existing functionality

**Changes**:
1. Add webhook-related fields to TestClient:
   ```typescript
   private expectedWebhooks = new Map<string, any[]>();
   private receivedWebhooks = new Map<string, any[]>();
   private webhookPort?: number;
   ```

2. Add webhook port to constructor options:
   ```typescript
   constructor(options: {
     clientId: string;
     appPort: number;
     webhookPort?: number;  // Add this
     livenessTimeoutMs?: number;
     // ... callbacks
   })
   ```

3. Add webhook methods to TestClient:
   ```typescript
   handleWebhook(triggerName: string, payload: any): void
   getWebhooks(triggerName: string): any[]
   expectWebhooks(triggerName: string, expected: any[]): void
   ```

4. Update completion checking to include webhooks:
   ```typescript
   private checkIfFinished() {
     const subscriptionComplete = !this.expectedState || 
       this.areStatesEqual(this.currentState, this.expectedState);
     const webhooksComplete = this.checkWebhooksComplete();
     
     if (subscriptionComplete && webhooksComplete) {
       // ... mark as finished
     }
   }
   ```

**Testing**: Existing tests should still pass as webhook fields are optional

### Step 3: Add HTTP Client for Queries/Mutations
**Goal**: TestClient can perform synchronous GraphQL operations

**Changes**:
1. Add Apollo Client to TestClient:
   ```typescript
   import { ApolloClient, InMemoryCache, gql } from '@apollo/client';
   
   private httpClient: ApolloClient<any>;
   ```

2. Initialize in constructor:
   ```typescript
   this.httpClient = new ApolloClient({
     uri: `http://localhost:${options.appPort}/graphql`,
     cache: new InMemoryCache(),
     fetch
   });
   ```

3. Add query and mutate methods:
   ```typescript
   async query<T>(query: string, variables?: any): Promise<T>
   async mutate<T>(mutation: string, variables?: any): Promise<T>
   ```

**Testing**: Write new tests for query/mutation operations

### Step 4: Add Trigger Creation to TestClient
**Goal**: TestClient can create triggers and track their webhooks

**Changes**:
1. Add `createTrigger()` method:
   ```typescript
   async createTrigger(
     source: string,
     trigger: {
       name: string;
       match: any;
       unmatch?: any;
       expectedWebhooks?: any[];
     }
   ): Promise<void> {
     const webhookUrl = `http://localhost:${this.webhookPort}/webhook/${this.clientId}/${trigger.name}`;
     
     if (trigger.expectedWebhooks) {
       this.expectWebhooks(trigger.name, trigger.expectedWebhooks);
     }
     
     await this.mutate(/* trigger mutation */, { /* variables */ });
   }
   ```

**Testing**: Test trigger creation and webhook URL generation

### Step 5: Update TestClientManager for Webhook Routing
**Goal**: Manager routes webhooks to appropriate clients

**Changes**:
1. Add webhookPort to constructor:
   ```typescript
   constructor(
     private port: number,
     private livenessTimeoutMs: number,
     private webhookPort: number
   )
   ```

2. Update createClient to pass webhookPort:
   ```typescript
   createClient(clientId?: string): TestClient {
     const client = new TestClient({
       clientId: id,
       appPort: this.port,
       webhookPort: this.webhookPort,
       livenessTimeoutMs: this.livenessTimeoutMs
     });
     // ... store in maps
   }
   ```

3. Add webhook routing:
   ```typescript
   handleWebhook(path: string, payload: any): void {
     // Parse path: /webhook/{clientId}/{triggerName}
     // Route to appropriate client
   }
   ```

**Testing**: Test webhook routing logic

### Step 6: Integrate with TestEnvironment
**Goal**: Connect TestEnvironment webhooks to TestClientManager

**Changes**:
1. Update test setup to pass webhook handler:
   ```typescript
   testEnv = await TestEnvironment.create({
     webhook: {
       port: webhookPort,
       endpoint: '/webhook/*',
       handler: async (payload, req) => {
         manager.handleWebhook(req.path, payload);
       }
     }
   });
   ```

2. Update manager creation with webhook port:
   ```typescript
   manager = new TestClientManager(4001, 30000, webhookPort);
   ```

**Testing**: Full E2E test with triggers and webhooks

### Step 7: Refactor Existing Tests
**Goal**: Update all existing tests to use new API

**Changes**:
1. Update tests to create client first, then subscribe:
   ```typescript
   const client = manager.createClient();
   await client.subscribe({ /* options */ });
   ```

2. Remove StartClientOptions in favor of direct method calls

**Testing**: All existing tests should pass

### Step 8: Write Trigger E2E Tests
**Goal**: Comprehensive tests for trigger functionality

**New Tests**:
1. Create trigger and verify webhook delivery
2. Test match/unmatch conditions
3. Test multiple triggers on same source
4. Test trigger deletion
5. Test concurrent triggers and subscriptions

## Validation Checklist

After each step, verify:
- [ ] Existing subscription tests still pass
- [ ] No breaking changes to public API (unless intentional)
- [ ] New functionality has tests
- [ ] Code compiles without errors

## Benefits of This Approach

1. **Incremental**: Each step is small and testable
2. **Non-breaking**: Existing tests continue to work during migration
3. **Clear ownership**: TestClient owns its operations, Manager just coordinates
4. **Extensible**: Easy to add new operation types (e.g., GraphQL subscriptions with variables)
5. **Type-safe**: Full TypeScript support throughout

## Example Usage After Refactoring

```typescript
describe('Unified E2E Test', () => {
  let testEnv: TestEnvironment;
  let manager: TestClientManager;

  beforeAll(async () => {
    const webhookPort = 7000;
    testEnv = await TestEnvironment.create({
      appPort: 4001,
      webhook: {
        port: webhookPort,
        endpoint: '/webhook/*',
        handler: async (payload, req) => {
          manager.handleWebhook(req.path, payload);
        }
      }
    });
    
    manager = new TestClientManager(4001, 30000, webhookPort);
  });

  it('should handle all operation types', async () => {
    const client = manager.createClient('unified-test');
    
    // Query
    const triggers = await client.query(`
      query { trades_triggers { name } }
    `);
    expect(triggers.trades_triggers).toEqual([]);
    
    // Mutation (create trigger)
    await client.createTrigger('trades', {
      name: 'high_price',
      match: { price: { _gt: 150 } },
      expectedWebhooks: [
        { event_type: 'MATCH', trigger_name: 'high_price' }
      ]
    });
    
    // Subscription
    await client.subscribe({
      query: `subscription { trades { operation data { id price } } }`,
      expectedState: new Map([[1, { id: 1, price: 200 }]]),
      dataPath: 'trades',
      idField: 'id'
    });
    
    // Trigger data changes
    await testEnv.executeSql(`INSERT INTO trades VALUES (1, 200)`);
    
    // Wait for everything
    await client.waitForCompletion();
    
    // Assert
    const webhooks = client.getWebhooks('high_price');
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0].event_type).toBe('MATCH');
  });
});
```

## Timeline Estimate

- Step 1-2: 2-3 hours (mostly mechanical refactoring)
- Step 3-4: 2-3 hours (new functionality)
- Step 5-6: 1-2 hours (integration)
- Step 7: 2-3 hours (updating existing tests)
- Step 8: 3-4 hours (writing new tests)

**Total: 10-15 hours of work**

## Risks and Mitigations

1. **Risk**: Breaking existing tests during refactoring
   - **Mitigation**: Run tests after each step, use version control to rollback

2. **Risk**: WebSocket and HTTP clients interfering
   - **Mitigation**: Keep them separate, different transports

3. **Risk**: Webhook routing complexity
   - **Mitigation**: Simple path-based routing, clear naming convention

4. **Risk**: Timing issues with async operations
   - **Mitigation**: Proper wait/completion checking, existing liveness timeout pattern