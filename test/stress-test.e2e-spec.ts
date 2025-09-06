import * as path from 'path';
import { 
  TestEnvironment, 
  OperationType, 
  OperationTemplate,
  TestScenario
} from './utils';

describe('Stress Test - Concurrent GraphQL Subscriptions', () => {
  let testEnv: TestEnvironment;

  // Test configuration
  const NUM_ITERATIONS = process.env.STRESS_TEST_ITERATIONS ? parseInt(process.env.STRESS_TEST_ITERATIONS) : 100;
  const NUM_CLIENTS = process.env.STRESS_TEST_CLIENTS ? parseInt(process.env.STRESS_TEST_CLIENTS) : 10;
  const INSERT_DELAY_MS = process.env.STRESS_TEST_DELAY ? parseInt(process.env.STRESS_TEST_DELAY) : 5;
  const TEST_TIMEOUT_MS = 300000; // 5 minute test timeout

  // Static test data - operation templates (IDs will be generated per iteration)
  const OPERATION_SEQUENCE: OperationTemplate[] = [
    { type: OperationType.INSERT, id: 1, fields: { value: 413, status: "inactive", department: "engineering" } },
    { type: OperationType.INSERT, id: 2, fields: { value: 13, status: "pending", department: "operations" } },
    { type: OperationType.INSERT, id: 3, fields: { value: 352, status: "active", department: "finance" } },
    { type: OperationType.INSERT, id: 4, fields: { value: 220, status: "inactive", department: "sales" } },
    { type: OperationType.INSERT, id: 5, fields: { value: 265, status: "pending", department: "engineering" } },
    { type: OperationType.INSERT, id: 6, fields: { value: 204, status: "active", department: "operations" } },
    { type: OperationType.INSERT, id: 7, fields: { value: 720, status: "inactive", department: "finance" } },
    { type: OperationType.INSERT, id: 8, fields: { value: 14, status: "pending", department: "sales" } },
    { type: OperationType.INSERT, id: 9, fields: { value: 26, status: "active", department: "engineering" } },
    { type: OperationType.INSERT, id: 10, fields: { value: 328, status: "inactive", department: "operations" } },
    { type: OperationType.UPDATE, id: 3, fields: { value: 462, status: "pending" } },
    { type: OperationType.INSERT, id: 11, fields: { value: 677, status: "pending", department: "finance" } },
    { type: OperationType.UPDATE, id: 3, fields: { value: 538 } },
    { type: OperationType.INSERT, id: 12, fields: { value: 671, status: "active", department: "sales" } },
    { type: OperationType.UPDATE, id: 6, fields: { status: "inactive" } },
    { type: OperationType.INSERT, id: 13, fields: { value: 413, status: "inactive", department: "engineering" } },
    { type: OperationType.UPDATE, id: 5, fields: { value: 184, status: "inactive" } },
    { type: OperationType.INSERT, id: 14, fields: { value: 319, status: "pending", department: "operations" } },
    { type: OperationType.UPDATE, id: 4, fields: { value: 586 } },
    { type: OperationType.INSERT, id: 15, fields: { value: 807, status: "active", department: "finance" } },
    { type: OperationType.UPDATE, id: 10, fields: { status: "pending" } },
    { type: OperationType.INSERT, id: 16, fields: { value: 292, status: "inactive", department: "sales" } },
    { type: OperationType.UPDATE, id: 16, fields: { value: 634, status: "active" } },
    { type: OperationType.INSERT, id: 17, fields: { value: 191, status: "pending", department: "engineering" } },
    { type: OperationType.UPDATE, id: 9, fields: { value: 113 } },
    { type: OperationType.INSERT, id: 18, fields: { value: 922, status: "active", department: "operations" } },
    { type: OperationType.DELETE, id: 13, fields: {} },
    { type: OperationType.INSERT, id: 19, fields: { value: 900, status: "inactive", department: "finance" } },
    { type: OperationType.UPDATE, id: 15, fields: { status: "inactive" } },
    { type: OperationType.INSERT, id: 20, fields: { value: 542, status: "pending", department: "sales" } },
    { type: OperationType.UPDATE, id: 5, fields: { value: 64, status: "inactive" } },
    { type: OperationType.DELETE, id: 2, fields: {} }
  ];

  // Expected final states by department
  const EXPECTED_ENGINEERING_STATE = new Map([
    [1, { id: 1, value: 413, status: "inactive", department: "engineering" }],
    [5, { id: 5, value: 64, status: "inactive", department: "engineering" }],
    [9, { id: 9, value: 113, status: "active", department: "engineering" }],
    [17, { id: 17, value: 191, status: "pending", department: "engineering" }]
  ]);

  const EXPECTED_OPERATIONS_STATE = new Map([
    [6, { id: 6, value: 204, status: "inactive", department: "operations" }],
    [10, { id: 10, value: 328, status: "pending", department: "operations" }],
    [14, { id: 14, value: 319, status: "pending", department: "operations" }],
    [18, { id: 18, value: 922, status: "active", department: "operations" }]
  ]);

  const EXPECTED_FINANCE_STATE = new Map([
    [3, { id: 3, value: 538, status: "pending", department: "finance" }],
    [7, { id: 7, value: 720, status: "inactive", department: "finance" }],
    [11, { id: 11, value: 677, status: "pending", department: "finance" }],
    [15, { id: 15, value: 807, status: "inactive", department: "finance" }],
    [19, { id: 19, value: 900, status: "inactive", department: "finance" }]
  ]);

  const EXPECTED_SALES_STATE = new Map([
    [4, { id: 4, value: 586, status: "inactive", department: "sales" }],
    [8, { id: 8, value: 14, status: "pending", department: "sales" }],
    [12, { id: 12, value: 671, status: "active", department: "sales" }],
    [16, { id: 16, value: 634, status: "active", department: "sales" }],
    [20, { id: 20, value: 542, status: "pending", department: "sales" }]
  ]);

  const DEPARTMENT_STATES = new Map([
    ['engineering', EXPECTED_ENGINEERING_STATE],
    ['operations', EXPECTED_OPERATIONS_STATE],
    ['finance', EXPECTED_FINANCE_STATE],
    ['sales', EXPECTED_SALES_STATE]
  ]);

  const DEPARTMENTS = Array.from(DEPARTMENT_STATES.keys());

  // Expected trigger events for base iteration (will be expanded for multiple iterations)
  const EXPECTED_HIGH_VALUE_EVENTS = [
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 7, value: 720, status: 'inactive', department: 'finance' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 11, value: 677, status: 'pending', department: 'finance' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 12, value: 671, status: 'active', department: 'sales' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 15, value: 807, status: 'active', department: 'finance' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 16, value: 634, status: 'active', department: 'sales' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 18, value: 922, status: 'active', department: 'operations' }},
    { event_type: 'FIRE', trigger_name: 'high_value_trigger', data: { id: 19, value: 900, status: 'inactive', department: 'finance' }}
  ];

  const EXPECTED_ENGINEERING_ACTIVE_EVENTS = [
    { event_type: 'FIRE', trigger_name: 'engineering_active_trigger', data: { id: 9, value: 26, status: 'active', department: 'engineering' }}
  ];

  const EXPECTED_OPERATIONS_VALUE_EVENTS = [
    { event_type: 'FIRE', trigger_name: 'operations_value_trigger', data: { id: 10, value: 328, status: 'inactive', department: 'operations' }},
    { event_type: 'FIRE', trigger_name: 'operations_value_trigger', data: { id: 14, value: 319, status: 'pending', department: 'operations' }},
    { event_type: 'FIRE', trigger_name: 'operations_value_trigger', data: { id: 18, value: 922, status: 'active', department: 'operations' }}
  ];

  beforeAll(async () => {
    console.log(`Starting stress test with ${OPERATION_SEQUENCE.length} base operations and ${NUM_CLIENTS} concurrent clients`);
    
    // Bootstrap test environment
    testEnv = await TestEnvironment.create({
      appPort: 4100,
      schemaPath: path.join(__dirname, 'stress-test-schema.yaml'),
      database: {
        host: 'localhost',
        port: 6875,
        user: 'materialize',
        password: 'materialize',
        name: 'materialize',
        workers: '4'
      },
      graphqlUI: false,
      logLevel: 'error',
      webhook: {
        port: 3001
      }
    });
    
    // Create test table
    await testEnv.executeSql(`
      CREATE TABLE IF NOT EXISTS stress_test (
        id INTEGER NOT NULL,
        value NUMERIC NOT NULL,
        status VARCHAR(10) NOT NULL,
        department VARCHAR(20) NOT NULL
      )
    `);
  }, 60000);

  afterAll(async () => {
    await testEnv.stop();
  });

  it('should handle concurrent clients with static operations and triggers', async () => {
    // Create test scenario with all operations and expected states
    const scenario = new TestScenario(OPERATION_SEQUENCE, NUM_ITERATIONS);
    const allOperations = scenario.getOperations();
    
    console.log(`Executing ${allOperations.length} operations (${NUM_ITERATIONS} iterations of ${OPERATION_SEQUENCE.length} operations)...`);
    
    try {
      // Set up triggers before starting operations
      console.log('Setting up triggers...');
      
      // Create trigger clients
      const triggerClient1 = testEnv.createClient('trigger-high-value');
      const triggerClient2 = testEnv.createClient('trigger-engineering-active');
      const triggerClient3 = testEnv.createClient('trigger-operations-value');
      
      // High Value Trigger: Match when value >= 600, unmatch when value < 500
      await triggerClient1.trigger('high-value', {
        query: `
          mutation CreateHighValueTrigger($webhookUrl: String!) {
            create_stress_test_trigger(input: {
              name: "high_value_trigger"
              webhook: $webhookUrl
              fire: {
                value: { _gte: 600 }
              }
              clear: {
                value: { _lt: 500 }
              }
            }) {
              name
              webhook
            }
          }
        `,
        deleteQuery: `
          mutation DeleteHighValueTrigger($name: String!) {
            delete_stress_test_trigger(name: $name) {
              name
            }
          }
        `,
        expectedEvents: scenario.getTriggerEvents(EXPECTED_HIGH_VALUE_EVENTS),
        idField: 'event_id'
      });
      
      // Engineering Active Trigger: Match when department = "engineering" AND status = "active"
      // Unmatch when still in engineering but status changes to non-active
      await triggerClient2.trigger('engineering-active', {
        query: `
          mutation CreateEngineeringActiveTrigger($webhookUrl: String!) {
            create_stress_test_trigger(input: {
              name: "engineering_active_trigger"
              webhook: $webhookUrl
              fire: {
                department: { _eq: "engineering" }
                status: { _eq: "active" }
              }
              clear: {
                department: { _eq: "engineering" }
                status: { _neq: "active" }
              }
            }) {
              name
              webhook
            }
          }
        `,
        deleteQuery: `
          mutation DeleteEngineeringActiveTrigger($name: String!) {
            delete_stress_test_trigger(name: $name) {
              name
            }
          }
        `,
        expectedEvents: scenario.getTriggerEvents(EXPECTED_ENGINEERING_ACTIVE_EVENTS),
        idField: 'event_id'
      });
      
      // Operations Value Trigger: Match when department = "operations" AND value >= 300
      // Unmatch when still in operations but value drops below 250 (hysteresis)
      await triggerClient3.trigger('operations-value', {
        query: `
          mutation CreateOperationsValueTrigger($webhookUrl: String!) {
            create_stress_test_trigger(input: {
              name: "operations_value_trigger"
              webhook: $webhookUrl
              fire: {
                department: { _eq: "operations" }
                value: { _gte: 300 }
              }
              clear: {
                department: { _eq: "operations" }
                value: { _lt: 250 }
              }
            }) {
              name
              webhook
            }
          }
        `,
        deleteQuery: `
          mutation DeleteOperationsValueTrigger($name: String!) {
            delete_stress_test_trigger(name: $name) {
              name
            }
          }
        `,
        expectedEvents: scenario.getTriggerEvents(EXPECTED_OPERATIONS_VALUE_EVENTS),
        idField: 'event_id'
      });
      
      console.log('Triggers set up successfully');
      
      // Execute the operations asynchronously
      const operationsPromise = (async () => {
        for (const { sql, params } of allOperations) {
          await testEnv.executeSql(sql, params, INSERT_DELAY_MS);
        }
        console.log('All database operations completed');
      })();
      
      // Create clients at staggered intervals
      console.log('Creating subscription clients at staggered intervals...');
      const clientSpawnInterval = Math.floor((allOperations.length * INSERT_DELAY_MS * 2.5) / NUM_CLIENTS);
      
      // Start clients with department filters
      for (let i = 0; i < NUM_CLIENTS; i++) {
        const clientDepartment = DEPARTMENTS[i % DEPARTMENTS.length];
        const baseDepartmentState = DEPARTMENT_STATES.get(clientDepartment)!;
        
        // Get expected state for this department using the scenario
        const departmentExpectedState = scenario.getSubscriptionState(baseDepartmentState);
        
        console.log(`Client ${i}: Subscribing to department '${clientDepartment}' (expecting ${departmentExpectedState.size} rows)`);
        
        const client = testEnv.createClient(`stress-client-${i}`);
        await client.subscribe('department-filter', {
          query: `
            subscription {
              stress_test(where: {department: {_eq: "${clientDepartment}"}}) {
                operation
                data {
                  id
                  value
                  status
                  department
                }
                fields
              }
            }
          `,
          expectedState: departmentExpectedState,
          dataPath: 'stress_test',
          idField: 'id'
        });
        
        // Stagger client creation
        if (i < NUM_CLIENTS - 1) {
          await new Promise(resolve => setTimeout(resolve, clientSpawnInterval));
        }
      }
      
      // Wait for all operations to complete
      await operationsPromise;
      
      // Wait for all clients to finish
      await testEnv.waitForCompletion();
      
      console.log(`Stress test completed successfully. All ${NUM_CLIENTS} subscription clients received their department-filtered data.`);
      console.log(`All 3 trigger clients received their expected webhook events.`);
      
      // Log final stats
      const stats = testEnv.getStats();
      console.log(`Test completed: received ${stats.totalReceived}/${stats.totalExpected} total items across all clients and triggers`);
      
    } catch (error) {
      console.error('Test failed:', error);
      
      // Log stats on failure
      const stats = testEnv.getStats();
      console.log(`Test failed: received ${stats.totalReceived}/${stats.totalExpected} total items`);
      
      throw error;
    }
  }, TEST_TIMEOUT_MS);
});