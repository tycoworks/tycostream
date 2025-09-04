import * as path from 'path';
import { TestEnvironment } from './utils';

enum Status {
  Active = 'active',
  Inactive = 'inactive',
  Pending = 'pending'
}

enum Department {
  Sales = 'sales',
  Engineering = 'engineering',
  Operations = 'operations',
  Finance = 'finance'
}

interface StressTestData {
  id: number;
  value: number;
  status: Status;
  department: string;
}

// Define updatable fields (excluding primary key)
const UPDATABLE_FIELDS = ['value', 'status'] as const;

describe('Stress Test - Concurrent GraphQL Subscriptions', () => {
  let testEnv: TestEnvironment;

  // Test configuration
  const NUM_ROWS = process.env.STRESS_TEST_ROWS ? parseInt(process.env.STRESS_TEST_ROWS) : 10000;
  const NUM_CLIENTS = process.env.STRESS_TEST_CLIENTS ? parseInt(process.env.STRESS_TEST_CLIENTS) : 30;
  const INSERT_DELAY_MS = process.env.STRESS_TEST_DELAY ? parseInt(process.env.STRESS_TEST_DELAY) : 5;
  const TEST_TIMEOUT_MS = 600000; // 10 minutes total test timeout
  const DEPARTMENTS = Object.values(Department);

  beforeAll(async () => {
    console.log(`Starting stress test with ${NUM_ROWS} rows and ${NUM_CLIENTS} concurrent clients`);
    
    // Bootstrap test environment with more workers for stress test
    testEnv = await TestEnvironment.create({
      appPort: 4100,
      schemaPath: path.join(__dirname, 'stress-test-schema.yaml'),
      database: {
        host: 'localhost',
        port: 6875,
        user: 'materialize',
        password: 'materialize',
        name: 'materialize',
        workers: '4'  // More workers for better stress test performance
      },
      graphqlUI: false,
      logLevel: 'error',
      webhook: {
        port: 3001
      }
    });
    
    // Create test table with multiple columns for testing partial updates
    await testEnv.executeSql(`
      CREATE TABLE IF NOT EXISTS stress_test (
        id INTEGER NOT NULL,
        value NUMERIC NOT NULL,
        status VARCHAR(10) NOT NULL,
        department VARCHAR(20) NOT NULL
      )
    `);
  }, 300000); // 5 minute timeout for beforeAll

  afterAll(async () => {
    await testEnv.stop();
  });

  it('should handle concurrent clients with mixed operations', async () => {
    // Clear any existing data first
    await testEnv.executeSql('DELETE FROM stress_test', [], 500);
    
    // Generate test operations
    console.log(`Generating ${NUM_ROWS} rows worth of operations...`);
    const { operations, expectedStates } = generateTestOperations(NUM_ROWS);
    const operationCount = operations.length;
    
    let totalRows = 0;
    expectedStates.forEach((state, dept) => totalRows += state.size);
    console.log(`Expected final state: ${totalRows} rows, ${operationCount} total operations`);
    expectedStates.forEach((state, dept) => {
      console.log(`  ${dept}: ${state.size} rows`);
    });
    
    try {
      // Execute the pre-calculated operations
      console.log(`Starting ${operations.length} database operations...`);
      const operationsPromise = (async () => {
        for (const op of operations) {
          await testEnv.executeSql(op.sql, op.params, INSERT_DELAY_MS);
        }
        console.log('All database operations completed');
      })();
      
      // Create clients at staggered intervals
      console.log('Creating clients at staggered intervals...');
      const clientSpawnInterval = Math.floor((NUM_ROWS * INSERT_DELAY_MS * 2.5) / NUM_CLIENTS);
      
      // Start clients with department filters
      for (let i = 0; i < NUM_CLIENTS; i++) {
        const clientDepartment = DEPARTMENTS[i % DEPARTMENTS.length];
        const departmentExpectedState = expectedStates.get(clientDepartment)!;
        
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
        
        // Stagger client creation to avoid thundering herd
        if (i < NUM_CLIENTS - 1) {
          await new Promise(resolve => setTimeout(resolve, clientSpawnInterval));
        }
      }
      
      // Wait for all operations to complete
      await operationsPromise;
      
      // Give a moment for final events to propagate
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Wait for either all clients to finish or timeout
      await testEnv.waitForCompletion();
      
      console.log(`Stress test completed successfully. All ${NUM_CLIENTS} clients received their department-filtered data.`);
      
      // Log final stats
      const stats = testEnv.stats;
      console.log('Client statistics:');
      stats.forEach(stat => {
        console.log(`  Client ${stat.clientId}: state size: ${stat.stateSize}`);
      });
      
    } catch (error) {
      console.error('Test failed:', error);
      
      // Log client stats on failure
      const stats = testEnv.stats;
      console.log('Client statistics at failure:');
      stats.forEach(stat => {
        console.log(`  Client ${stat.clientId}: state size: ${stat.stateSize}, finished: ${stat.isFinished}`);
      });
      
      throw error;
    }
  }, TEST_TIMEOUT_MS);
});

// Helper function to generate test operations
function generateTestOperations(numRows: number): {
  operations: Array<{ sql: string, params: any[] }>,
  expectedStates: Map<Department, Map<number, StressTestData>>
} {
  const expectedState = new Map<number, StressTestData>();
  const operations: Array<{ sql: string, params: any[] }> = [];
  const departments = Object.values(Department);
  
  // Use deterministic random for reproducible results
  let seed = 12345;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  const statusValues = Object.values(Status);
  const numUpdatePatterns = (1 << UPDATABLE_FIELDS.length) - 1;
  
  for (let i = 1; i <= numRows; i++) {
    // INSERT
    const insertValue = Math.floor(random() * 1000);
    const insertStatus = statusValues[i % statusValues.length];
    const insertDepartment = departments[i % departments.length];
    operations.push({ 
      sql: 'INSERT INTO stress_test (id, value, status, department) VALUES ($1, $2, $3, $4)',
      params: [i, insertValue, insertStatus, insertDepartment]
    });
    const row = { id: i, value: insertValue, status: insertStatus, department: insertDepartment };
    expectedState.set(i, row);
    
    // UPDATE (only update existing rows)
    if (i > 10) {
      const updateId = Math.floor(random() * (i - 1)) + 1;
      // Only update if not previously deleted
      if (expectedState.has(updateId)) {
        const fieldValues = {
          value: Math.floor(random() * 1000),
          status: statusValues[(updateId + i) % statusValues.length]
        };
        const updatePattern = (i % numUpdatePatterns) + 1;
        
        const { setClause, params, updates } = buildPartialUpdate(updatePattern, fieldValues);
        
        operations.push({
          sql: `UPDATE stress_test SET ${setClause} WHERE id = $${params.length + 1}`,
          params: [...params, updateId]
        });
        
        // Merge updates with existing row
        expectedState.set(updateId, {
          ...expectedState.get(updateId)!,
          ...updates
        });
      }
    }
    
    // DELETE (only delete older rows)
    if (i > 20 && i % 10 === 0) {
      const deleteId = Math.floor(random() * (i - 10)) + 1;
      if (expectedState.has(deleteId)) {
        operations.push({
          sql: 'DELETE FROM stress_test WHERE id = $1',
          params: [deleteId]
        });
        expectedState.delete(deleteId);
      }
    }
  }
  
  // Filter final state by department
  const expectedStates = new Map<Department, Map<number, StressTestData>>();
  for (const dept of departments) {
    const deptState = new Map<number, StressTestData>();
    expectedState.forEach((row, id) => {
      if (row.department === dept) {
        deptState.set(id, row);
      }
    });
    expectedStates.set(dept, deptState);
  }
  
  return { operations, expectedStates };
}

// Helper to build partial UPDATE statements based on bit pattern
function buildPartialUpdate(updatePattern: number, fieldValues: Record<string, any>): { 
  setClause: string, 
  params: any[], 
  updates: Record<string, any> 
} {
  // Use bitmask to determine which fields to update
  const updates: Record<string, any> = {};
  const setClauses: string[] = [];
  const params: any[] = [];
  
  UPDATABLE_FIELDS.forEach((fieldName, index) => {
    // Check if bit at position 'index' is set
    if (updatePattern & (1 << index)) {
      updates[fieldName] = fieldValues[fieldName];
      setClauses.push(`${fieldName} = $${params.length + 1}`);
      params.push(fieldValues[fieldName]);
    }
  });
  
  return {
    setClause: setClauses.join(', '),
    params,
    updates
  };
}