import * as path from 'path';
import { Client as WSClient } from 'graphql-ws';
import {
  TestContext,
  bootstrapTestEnvironment,
  cleanupTestEnvironment,
  createWebSocketClient,
  executeAndWait
} from './e2e-test-utils';

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
  const CLIENT_TIMEOUT_MS = 10000; // 10 seconds - realistic timeout
  const RECONNECT_ATTEMPTS = 3;
  const RECONNECT_DELAY_MS = 1000;

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
  }, 180000);

  afterAll(async () => {
    await cleanupTestEnvironment(testContext);
  });

  it('should handle concurrent clients with mixed operations', async () => {
    // Clear any existing data first
    await testContext.pgClient.query('DELETE FROM stress_test');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    const clients: WSClient[] = [];
    const clientResults: Map<number, Map<number, number>> = new Map(); // clientId -> (rowId -> value)
    const clientConnected: boolean[] = new Array(NUM_CLIENTS).fill(false);
    const clientSubscribed: boolean[] = new Array(NUM_CLIENTS).fill(false);
    const clientJoinTimes: number[] = new Array(NUM_CLIENTS).fill(0); // Track when each client joined
    const operationsAtJoin: number[] = new Array(NUM_CLIENTS).fill(0); // Track how many ops had occurred when client joined
    
    // Helper to create WebSocket client with reconnection logic
    const createWSClientWithRetry = async (clientId: number): Promise<WSClient | null> => {
      for (let attempt = 1; attempt <= RECONNECT_ATTEMPTS; attempt++) {
        try {
          // Use simple configuration like the working test
          const client = createWebSocketClient(appPort);
          
          // Mark as connected after successful creation
          clientConnected[clientId] = true;
          console.log(`Client ${clientId} created (attempt ${attempt})`);
          
          return client;
        } catch (error: any) {
          console.log(`Client ${clientId} connection attempt ${attempt} failed:`, error?.message || error);
          if (attempt < RECONNECT_ATTEMPTS) {
            await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
          }
        }
      }
      return null;
    };

    // Helper to subscribe
    const subscribeClient = (client: WSClient, clientId: number) => {
      const results = new Map<number, number>(); // rowId -> value
      clientResults.set(clientId, results);
      
      client.subscribe(
        {
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
          `
        },
        {
          next: (data: SubscriptionResponse) => {
            if (!clientSubscribed[clientId]) {
              clientSubscribed[clientId] = true;
              console.log(`Client ${clientId} subscribed and receiving data`);
            }
            
            // Track the current state properly
            if (data?.data?.stress_test) {
              const op = data.data.stress_test.operation;
              const row = data.data.stress_test.data;
              if (row) {
                // Check types match schema (id: integer, value: numeric)
                if (typeof row.id !== 'number') {
                  console.error(`ERROR: Client ${clientId} received id as ${typeof row.id} instead of number: ${row.id}`);
                }
                // For DELETE operations, value can be null
                if (op !== 'DELETE' && typeof row.value !== 'number') {
                  console.error(`ERROR: Client ${clientId} received value as ${typeof row.value} instead of number: ${row.value}`);
                }
                if (op === 'DELETE' && row.value !== null && typeof row.value !== 'number') {
                  console.error(`ERROR: Client ${clientId} DELETE operation has non-null, non-number value: ${row.value}`);
                }
                
                // Store with original types to catch any inconsistencies
                const id = row.id;
                const value = row.value;
                
                if (op === 'DELETE') {
                  results.delete(id);
                } else {
                  // INSERT or UPDATE - just set the current value
                  results.set(id, value);
                }
              }
            }
          },
          error: (error) => {
            console.error(`Client ${clientId} subscription error:`, error);
          },
          complete: () => {
            console.log(`Client ${clientId} subscription completed`);
          },
        }
      );
    };

    // Track expected state and operation count
    const expectedState = new Map<number, number>(); // id -> value
    const operationLog: string[] = []; // For debugging
    let operationCount = 0;
    
    // Start database operations immediately
    console.log(`Starting mixed operations with ${NUM_ROWS} rows...`);
    
    // Use deterministic random for reproducible results
    let seed = 12345;
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    
    // Start operations in background
    const operationsPromise = (async () => {
      for (let i = 1; i <= NUM_ROWS; i++) {
        // INSERT
        const insertValue = i * 1.5;
        expectedState.set(i, insertValue);
        operationLog.push(`INSERT id=${i} value=${insertValue}`);
        operationCount++;
        
        await testContext.pgClient.query('INSERT INTO stress_test (id, value) VALUES ($1, $2)', [i, insertValue]);
        await new Promise(resolve => setTimeout(resolve, INSERT_DELAY_MS));
        
        // UPDATE (only update existing rows)
        if (i > 10) {
          const updateId = Math.floor(random() * (i - 1)) + 1;
          // Only update if the row still exists (hasn't been deleted)
          if (expectedState.has(updateId)) {
            const updateValue = updateId * 2.5;
            expectedState.set(updateId, updateValue);
            operationLog.push(`UPDATE id=${updateId} value=${updateValue}`);
            operationCount++;
            
            await testContext.pgClient.query('UPDATE stress_test SET value = $1 WHERE id = $2', [updateValue, updateId]);
            await new Promise(resolve => setTimeout(resolve, INSERT_DELAY_MS));
          }
        }
        
        // DELETE (only delete older rows)
        if (i > 20 && i % 10 === 0) {
          const deleteId = Math.floor(random() * (i - 10)) + 1;
          if (expectedState.has(deleteId)) {
            expectedState.delete(deleteId);
            operationLog.push(`DELETE id=${deleteId}`);
            operationCount++;
            
            await testContext.pgClient.query('DELETE FROM stress_test WHERE id = $1', [deleteId]);
            await new Promise(resolve => setTimeout(resolve, INSERT_DELAY_MS));
          }
        }
      }
    })();
    
    // Now create clients at different points during the operations
    console.log('Creating clients at staggered intervals...');
    
    // Calculate when to spawn clients
    const clientSpawnInterval = Math.floor((NUM_ROWS * INSERT_DELAY_MS * 2.5) / NUM_CLIENTS); // Spread across ~2.5x operation time
    
    for (let i = 0; i < NUM_CLIENTS; i++) {
      // Record when this client is joining
      clientJoinTimes[i] = Date.now();
      operationsAtJoin[i] = operationCount;
      
      const client = await createWSClientWithRetry(i);
      if (client) {
        clients.push(client);
        subscribeClient(client, i);
        console.log(`Client ${i} joined at operation ${operationCount}/${NUM_ROWS * 3}`);
      } else {
        console.error(`Failed to create client ${i} after ${RECONNECT_ATTEMPTS} attempts`);
      }
      
      // Wait before spawning next client
      if (i < NUM_CLIENTS - 1) {
        await new Promise(resolve => setTimeout(resolve, clientSpawnInterval));
      }
    }
    
    // Wait for all operations to complete
    await operationsPromise;
    console.log('All database operations completed');
    
    // Wait for events to propagate to all clients
    console.log('Waiting for events to propagate to all clients...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const connectedCount = clientConnected.filter(c => c).length;
    const subscribedCount = clientSubscribed.filter(s => s).length;
    console.log(`Connected clients: ${connectedCount}/${NUM_CLIENTS}`);
    console.log(`Subscribed clients: ${subscribedCount}/${NUM_CLIENTS}`);
    
    console.log(`Expected data set size: ${expectedState.size}`);
    console.log(`Total operations: ${operationCount}`);
    
    // Show when each client joined
    console.log('\nClient join times:');
    for (let i = 0; i < Math.min(5, NUM_CLIENTS); i++) {
      console.log(`  Client ${i}: joined at operation ${operationsAtJoin[i]}/${operationCount}`);
    }
    
    // Debug: Show some sample expected data
    const sampleExpected = Array.from(expectedState.entries()).slice(0, 5);
    console.log('\nSample expected data:', sampleExpected);
    
    // Verify database has the correct data
    const finalResult = await testContext.pgClient.query('SELECT id, value FROM stress_test ORDER BY id');
    const dbData = new Map<number, number>();
    finalResult.rows.forEach(row => {
      dbData.set(Number(row.id), Number(row.value));
    });
    
    if (dbData.size !== expectedState.size) {
      console.error(`Database has ${dbData.size} rows, expected ${expectedState.size}`);
      // Show differences
      for (const [id, value] of expectedState) {
        if (!dbData.has(id) || dbData.get(id) !== value) {
          console.error(`Database missing or wrong: id=${id} expected=${value} actual=${dbData.get(id)}`);
        }
      }
      for (const [id, value] of dbData) {
        if (!expectedState.has(id)) {
          console.error(`Database has unexpected: id=${id} value=${value}`);
        }
      }
    }
    
    // Verify all subscribed clients have the correct data
    let allMatch = true;
    let typeErrors = false;
    const subscribedClients = Array.from(clientResults.entries())
      .filter(([clientId]) => clientSubscribed[clientId]);
    
    // Debug: Show what the first client has
    if (subscribedClients.length > 0) {
      const [firstClientId, firstClientData] = subscribedClients[0];
      const sampleClientData = Array.from(firstClientData.entries()).slice(0, 5);
      console.log(`Sample data from client ${firstClientId}:`, sampleClientData);
    }
    
    for (const [clientId, clientData] of subscribedClients) {
      if (clientData.size !== expectedState.size) {
        console.error(`Client ${clientId} has ${clientData.size} rows, expected ${expectedState.size}`);
        allMatch = false;
        
        // Show first few differences for debugging
        let shown = 0;
        for (const [id, expectedValue] of expectedState) {
          const actualValue = clientData.get(id);
          if (actualValue === undefined || actualValue !== expectedValue) {
            if (shown++ < 5) {
              console.error(`  Client ${clientId} missing or wrong: id=${id} expected=${expectedValue} actual=${actualValue}`);
            }
          }
        }
        for (const [id, actualValue] of clientData) {
          if (!expectedState.has(id)) {
            if (shown++ < 10) {
              console.error(`  Client ${clientId} has unexpected: id=${id} value=${actualValue}`);
            }
          }
        }
      } else {
        // Check if data matches exactly
        for (const [id, expectedValue] of expectedState) {
          const actualValue = clientData.get(id);
          if (actualValue !== expectedValue) {
            console.error(`Client ${clientId} wrong value: id=${id} expected=${expectedValue} actual=${actualValue}`);
            allMatch = false;
            break;
          }
          
          // Also check types
          if (typeof id !== 'number' || typeof actualValue !== 'number') {
            console.error(`Client ${clientId} type error: id type=${typeof id}, value type=${typeof actualValue}`);
            typeErrors = true;
          }
        }
      }
    }
    
    // Clean up clients
    clients.forEach(client => client.dispose());
    
    // Check for type errors
    if (typeErrors) {
      throw new Error('Type errors detected - GraphQL returned wrong types!');
    }
    
    // Final verification
    if (expectedState.size === 0) {
      throw new Error('SUSPICIOUS: Expected state is empty!');
    }
    if (subscribedClients.length === 0) {
      throw new Error('SUSPICIOUS: No subscribed clients!');
    }
    for (const [clientId, clientData] of subscribedClients) {
      if (clientData.size === 0) {
        throw new Error(`SUSPICIOUS: Client ${clientId} has no data!`);
      }
    }
    
    expect(allMatch).toBe(true);
    console.log(`Stress test completed. All ${subscribedClients.length} clients have identical data with correct types.`);
  }, 300000); // 5 minute timeout for the test
});