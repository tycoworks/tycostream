import * as path from 'path';
import {
  TestContext,
  bootstrapTestEnvironment,
  cleanupTestEnvironment,
} from './e2e-test-utils';
import { TestClientManager } from './graphql-test-client';

interface StressTestData {
  id: number;
  value: number;
}

interface StressTestUpdate {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data: StressTestData | null;
}

interface SubscriptionResponse {
  data: {
    stress_test: StressTestUpdate;
  };
}

describe('Stress Test - Concurrent GraphQL Subscriptions', () => {
  let testContext: TestContext;
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
    testContext = await bootstrapTestEnvironment({
      appPort,
      schemaPath: path.join(__dirname, 'stress-test-schema.yaml'),
      materializeWorkers: '4' // More workers for stress test
    });
    
    // Create test table with single numeric column
    await testContext.pgClient.query(`
      CREATE TABLE IF NOT EXISTS stress_test (
        id INTEGER NOT NULL,
        value NUMERIC NOT NULL
      )
    `);
  }, 300000); // 5 minute timeout for beforeAll

  afterAll(async () => {
    await cleanupTestEnvironment(testContext);
  });

  it('should handle concurrent clients with mixed operations', async () => {
    // Clear any existing data first
    await testContext.pgClient.query('DELETE FROM stress_test');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Track expected state and operation count
    const expectedState = new Map<number, number>(); // id -> value
    let operationCount = 0;
    
    // Use deterministic random for reproducible results
    let seed = 12345;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    
    // First, generate all operations to know the expected final state
    console.log(`Generating ${NUM_ROWS} rows worth of operations...`);
    const operations: Array<{ type: 'INSERT' | 'UPDATE' | 'DELETE', id: number, value?: number }> = [];
    
    for (let i = 1; i <= NUM_ROWS; i++) {
      // INSERT
      const insertValue = i * 1.5;
      operations.push({ type: 'INSERT', id: i, value: insertValue });
      expectedState.set(i, insertValue);
      
      // UPDATE (only update existing rows)
      if (i > 10) {
        const updateId = Math.floor(random() * (i - 1)) + 1;
        // Only update if not previously deleted
        if (expectedState.has(updateId)) {
          const updateValue = updateId * 2.5;
          operations.push({ type: 'UPDATE', id: updateId, value: updateValue });
          expectedState.set(updateId, updateValue);
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
    
    operationCount = operations.length;
    
    console.log(`Expected final state: ${expectedState.size} rows, ${operationCount} total operations`);
    
    // Create client manager
    const clientManager = new TestClientManager<SubscriptionResponse>(NUM_CLIENTS);
    
    try {
      // Execute the pre-calculated operations
      console.log(`Starting ${operations.length} database operations...`);
      const operationsPromise = (async () => {
        for (const op of operations) {
          switch (op.type) {
            case 'INSERT':
              await testContext.pgClient.query('INSERT INTO stress_test (id, value) VALUES ($1, $2)', [op.id, op.value]);
              break;
            case 'UPDATE':
              await testContext.pgClient.query('UPDATE stress_test SET value = $1 WHERE id = $2', [op.value, op.id]);
              break;
            case 'DELETE':
              await testContext.pgClient.query('DELETE FROM stress_test WHERE id = $1', [op.id]);
              break;
          }
          await new Promise(resolve => setTimeout(resolve, INSERT_DELAY_MS));
        }
        console.log('All database operations completed');
      })();
      
      // Create clients at staggered intervals
      console.log('Creating clients at staggered intervals...');
      const clientSpawnInterval = Math.floor((NUM_ROWS * INSERT_DELAY_MS * 2.5) / NUM_CLIENTS);
      
      for (let i = 0; i < NUM_CLIENTS; i++) {
        await clientManager.createAndStartClient({
          clientId: i,
          appPort,
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
          onUpdate: (data: SubscriptionResponse, currentState: Map<number, number>) => {
            if (data?.data?.stress_test) {
              const op = data.data.stress_test.operation;
              const row = data.data.stress_test.data;
              if (row) {
                const id = row.id;
                const value = row.value;
                
                if (op === 'DELETE') {
                  currentState.delete(id);
                } else {
                  currentState.set(id, value);
                }
              }
            }
          },
          isFinished: (currentState: Map<number, number>, expectedState: Map<number, number>) => {
            if (currentState.size !== expectedState.size) {
              return false;
            }
            
            // Verify data matches exactly
            for (const [id, expectedValue] of expectedState) {
              if (currentState.get(id) !== expectedValue) {
                return false;
              }
            }
            
            return true;
          },
          livenessTimeoutMs: CLIENT_LIVENESS_TIMEOUT_MS
        });
        
        console.log(`Client ${i} started at operation ~${Math.floor(i * operationCount / NUM_CLIENTS)}/${operationCount}`);
        
        // Wait before starting next client
        if (i < NUM_CLIENTS - 1) {
          await new Promise(resolve => setTimeout(resolve, clientSpawnInterval));
        }
      }
      
      // Wait for all operations to complete
      await operationsPromise;
      
      // Give a moment for final events to propagate
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Wait for either all clients to finish or timeout
      await clientManager.waitForCompletion(TEST_TIMEOUT_MS);
      
      console.log(`Stress test completed successfully. All ${NUM_CLIENTS} clients received identical data.`);
      
      // Verify final database state matches expected
      const finalResult = await testContext.pgClient.query('SELECT id, value FROM stress_test ORDER BY id');
      const dbData = new Map<number, number>();
      finalResult.rows.forEach(row => {
        dbData.set(Number(row.id), Number(row.value));
      });
      
      expect(dbData.size).toBe(expectedState.size);
      for (const [id, expectedValue] of expectedState) {
        expect(dbData.get(id)).toBe(expectedValue);
      }
      
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