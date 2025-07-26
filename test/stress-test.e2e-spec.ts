import * as path from 'path';
import {
  TestEnvironment,
  TestClientManager
} from './utils';

interface StressTestData {
  id: number;
  value: number;
}

describe('Stress Test - Concurrent GraphQL Subscriptions', () => {
  let testEnv: TestEnvironment;
  const appPort = 4100; // Different port to avoid conflicts

  // Test configuration
  const NUM_ROWS = process.env.STRESS_TEST_ROWS ? parseInt(process.env.STRESS_TEST_ROWS) : 10000;
  const NUM_CLIENTS = process.env.STRESS_TEST_CLIENTS ? parseInt(process.env.STRESS_TEST_CLIENTS) : 30;
  const INSERT_DELAY_MS = process.env.STRESS_TEST_DELAY ? parseInt(process.env.STRESS_TEST_DELAY) : 5;
  const CLIENT_LIVENESS_TIMEOUT_MS = 120000; // 120 seconds without messages = stalled
  const TEST_TIMEOUT_MS = 600000; // 10 minutes total test timeout

  beforeAll(async () => {
    console.log(`Starting stress test with ${NUM_ROWS} rows and ${NUM_CLIENTS} concurrent clients`);
    
    // Bootstrap test environment with more workers for stress test
    testEnv = await TestEnvironment.create(
      appPort,
      path.join(__dirname, 'stress-test-schema.yaml'),
      '4' // More workers for better stress test performance
    );
    
    // Create test table with single numeric column
    await testEnv.executeSql(`
      CREATE TABLE IF NOT EXISTS stress_test (
        id INTEGER NOT NULL,
        value NUMERIC NOT NULL
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
    const { operations, expectedState } = generateTestOperations(NUM_ROWS);
    const operationCount = operations.length;
    
    console.log(`Expected final state: ${expectedState.size} rows, ${operationCount} total operations`);
    
    // Create client manager
    const clientManager = new TestClientManager(testEnv.port, CLIENT_LIVENESS_TIMEOUT_MS);
    
    try {
      // Execute the pre-calculated operations
      console.log(`Starting ${operations.length} database operations...`);
      const operationsPromise = (async () => {
        for (const op of operations) {
          switch (op.type) {
            case 'INSERT':
              await testEnv.executeSql('INSERT INTO stress_test (id, value) VALUES ($1, $2)', [op.id, op.value], INSERT_DELAY_MS);
              break;
            case 'UPDATE':
              await testEnv.executeSql('UPDATE stress_test SET value = $1 WHERE id = $2', [op.value, op.id], INSERT_DELAY_MS);
              break;
            case 'DELETE':
              await testEnv.executeSql('DELETE FROM stress_test WHERE id = $1', [op.id], INSERT_DELAY_MS);
              break;
          }
        }
        console.log('All database operations completed');
      })();
      
      // Create clients at staggered intervals
      console.log('Creating clients at staggered intervals...');
      const clientSpawnInterval = Math.floor((NUM_ROWS * INSERT_DELAY_MS * 2.5) / NUM_CLIENTS);
      
      await clientManager.startClients(NUM_CLIENTS, clientSpawnInterval, {
        query: `
          subscription {
            stress_test {
              operation
              data {
                id
                value
              }
            }
          }
        `,
        expectedState,
        dataPath: 'stress_test',
        idField: 'id',
        onOperation: (operation, data) => {
          console.log(`Client received ${operation} for id ${data?.id || 'unknown'}`);
        }
      });
      
      // Wait for all operations to complete
      await operationsPromise;
      
      // Give a moment for final events to propagate
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Wait for either all clients to finish or timeout
      await clientManager.waitForCompletion();
      
      console.log(`Stress test completed successfully. All ${NUM_CLIENTS} clients received identical data.`);
      
      // Log final stats
      const stats = clientManager.stats;
      console.log('Client statistics:');
      stats.forEach(stat => {
        console.log(`  Client ${stat.clientId}: ${stat.eventCount} events, state size: ${stat.stateSize}`);
      });
      
    } catch (error) {
      console.error('Test failed:', error);
      
      // Log client stats on failure
      const stats = clientManager.stats;
      console.log('Client statistics at failure:');
      stats.forEach(stat => {
        console.log(`  Client ${stat.clientId}: ${stat.eventCount} events, state size: ${stat.stateSize}, finished: ${stat.isFinished}`);
      });
      
      throw error;
    } finally {
      // Clean up all clients
      clientManager.dispose();
    }
  }, TEST_TIMEOUT_MS);
});

// Helper function to generate test operations
function generateTestOperations(numRows: number): {
  operations: Array<{ type: 'INSERT' | 'UPDATE' | 'DELETE', id: number, value?: number }>,
  expectedState: Map<number, StressTestData>
} {
  const expectedState = new Map<number, StressTestData>();
  const operations: Array<{ type: 'INSERT' | 'UPDATE' | 'DELETE', id: number, value?: number }> = [];
  
  // Use deterministic random for reproducible results
  let seed = 12345;
  const random = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  
  for (let i = 1; i <= numRows; i++) {
    // INSERT
    const insertValue = i * 1.5;
    operations.push({ type: 'INSERT', id: i, value: insertValue });
    expectedState.set(i, { id: i, value: insertValue });
    
    // UPDATE (only update existing rows)
    if (i > 10) {
      const updateId = Math.floor(random() * (i - 1)) + 1;
      // Only update if not previously deleted
      if (expectedState.has(updateId)) {
        const updateValue = updateId * 2.5;
        operations.push({ type: 'UPDATE', id: updateId, value: updateValue });
        expectedState.set(updateId, { id: updateId, value: updateValue });
      }
    }
    
    // DELETE (only delete older rows)
    if (i > 20 && i % 10 === 0) {
      const deleteId = Math.floor(random() * (i - 10)) + 1;
      if (expectedState.has(deleteId)) {
        operations.push({ type: 'DELETE', id: deleteId });
        expectedState.delete(deleteId);
      }
    }
  }
  
  return { operations, expectedState };
}