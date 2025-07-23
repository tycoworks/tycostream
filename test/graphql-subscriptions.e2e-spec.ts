import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import * as WebSocket from 'ws';
import { createClient, Client as WSClient } from 'graphql-ws';
import { AppModule } from '../src/app.module';
import databaseConfig from '../src/config/database.config';
import graphqlConfig from '../src/config/graphql.config';
import appConfig from '../src/config/app.config';
import sourcesConfig from '../src/config/sources.config';
import * as path from 'path';

describe('GraphQL Subscriptions E2E', () => {
  let app: INestApplication;
  let materializeContainer: StartedTestContainer;
  let pgClient: Client;
  let wsClient: WSClient | undefined;
  const testPort = 4001;

  beforeAll(async () => {
    // Start Materialize container
    console.log('Starting Materialize container...');
    materializeContainer = await new GenericContainer('materialize/materialized:v0.124.0')
      .withExposedPorts(6875)
      .withEnvironment({
        MZ_WORKERS: '1'
      })
      .withStartupTimeout(120000) // 2 minute timeout
      .start();
    console.log('Materialize container started');
    
    const dbPort = materializeContainer.getMappedPort(6875);
    console.log('Materialize mapped port:', dbPort);
    
    // Connect to Materialize
    pgClient = new Client({
      host: 'localhost',
      port: dbPort,
      user: 'materialize',
      password: 'materialize',
      database: 'materialize',
    });
    
    // Wait a bit before connecting
    await new Promise(resolve => setTimeout(resolve, 2000));
    await pgClient.connect();
    console.log('Connected to Materialize');

    // Create test tables matching our schema
    await pgClient.query(`
      CREATE TABLE users (
        user_id INTEGER,
        name TEXT,
        email VARCHAR(255),
        active BOOLEAN,
        created_at TIMESTAMP,
        updated_at TIMESTAMPTZ,
        metadata JSON
      )
    `);

    await pgClient.query(`
      CREATE TABLE all_types (
        id INTEGER,
        bool_val BOOLEAN,
        smallint_val SMALLINT,
        int_val INTEGER,
        bigint_val BIGINT,
        decimal_val DECIMAL,
        numeric_val NUMERIC,
        real_val REAL,
        double_val DOUBLE PRECISION,
        char_val CHAR(10),
        varchar_val VARCHAR(255),
        text_val TEXT,
        uuid_val UUID,
        date_val DATE,
        time_val TIME,
        timestamp_val TIMESTAMP,
        timestamptz_val TIMESTAMPTZ,
        json_val JSON,
        jsonb_val JSONB
      )
    `);

    // Set environment variables
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = dbPort.toString();
    process.env.DATABASE_USER = 'materialize';
    process.env.DATABASE_PASSWORD = 'materialize';
    process.env.DATABASE_NAME = 'materialize';
    process.env.GRAPHQL_PORT = testPort.toString();
    process.env.GRAPHQL_UI = 'false';
    process.env.SCHEMA_PATH = path.join(__dirname, 'test-schema.yaml');
    process.env.LOG_LEVEL = 'error'; // Reduce noise in tests

    // Create NestJS application
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideModule(ConfigModule)
    .useModule(
      ConfigModule.forRoot({
        isGlobal: true,
        cache: false, // Disable cache to pick up env changes
        load: [appConfig, databaseConfig, graphqlConfig, sourcesConfig],
      })
    )
    .compile();

    app = moduleFixture.createNestApplication();
    await app.listen(testPort);

    // Wait a bit for server to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));
  }, 120000); // 2 minute timeout for entire setup

  afterAll(async () => {
    wsClient?.dispose();
    
    // Close app first and wait for cleanup
    if (app) {
      await app.close();
      // Wait a bit for all connections to close
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // End pg client connection
    await pgClient?.end();
    
    // Stop the container last to avoid triggering fail-fast
    if (materializeContainer) {
      await materializeContainer.stop();
    }
  });

  beforeEach(async () => {
    // Clear all tables
    await pgClient.query('DELETE FROM users');
    await pgClient.query('DELETE FROM all_types');
    
    // Wait for Materialize to process
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  // Helper to create WebSocket client
  function createWSClient(): WSClient {
    return createClient({
      url: `ws://localhost:${testPort}/graphql`,
      webSocketImpl: WebSocket as any,
    });
  }

  // Helper to collect subscription data
  async function collectSubscriptionData(
    query: string,
    variables?: Record<string, any>,
    timeout = 3000
  ): Promise<any[]> {
    const client = createWSClient();
    const results: any[] = [];
    
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void;
      
      const timeoutId = setTimeout(() => {
        unsubscribe?.();
        client.dispose();
        resolve(results);
      }, timeout);

      unsubscribe = client.subscribe(
        { query, variables },
        {
          next: (data) => results.push(data),
          error: (err) => {
            clearTimeout(timeoutId);
            client.dispose();
            reject(err);
          },
          complete: () => {
            clearTimeout(timeoutId);
            client.dispose();
            resolve(results);
          },
        }
      );
    });
  }

  describe('Basic Functionality', () => {
    it('should deliver snapshot and live updates', async () => {
      // Insert initial data
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES 
          (1001, 10, 100, 1000000, 9.99, 1.5, 2.25)
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start subscription
      const client = createWSClient();
      const results: any[] = [];
      
      client.subscribe(
        {
          query: `
            subscription {
              all_types {
                operation
                data {
                  id
                  int_val
                  decimal_val
                }
              }
            }
          `
        },
        {
          next: (data) => results.push(data),
          error: console.error,
          complete: () => {},
        }
      );

      // Wait for snapshot
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(results.length).toBe(1); // Initial snapshot
      expect(results[0].data.all_types.operation).toBe('INSERT');
      expect(results[0].data.all_types.data.id).toBe(1001);

      // Insert new data
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES 
          (1002, 20, 200, 2000000, 19.99, 3.0, 4.5)
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should have received the insert
      expect(results.length).toBeGreaterThanOrEqual(2);
      const insertEvent = results.find(r => 
        r.data.all_types.data?.id === 1002
      );
      expect(insertEvent).toBeDefined();
      expect(insertEvent.data.all_types.operation).toBe('INSERT');
      expect(insertEvent.data.all_types.data.int_val).toBe(200);
      
      client.dispose();
    });
  });

  describe('Multiple Sources', () => {
    it('should handle subscriptions to different sources', async () => {
      // Insert data into both tables
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES (1001, 10, 100, 1000000, 9.99, 1.5, 2.25)
      `);
      
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES 
          (1, 'Alice', 'alice@example.com', true, NOW(), NOW(), '{"role": "admin"}'),
          (2, 'Bob', 'bob@example.com', false, NOW(), NOW(), '{"role": "user"}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Subscribe to both sources in parallel
      const [dataTypesResults, usersResults] = await Promise.all([
        collectSubscriptionData(`
          subscription {
            all_types {
              operation
              data {
                id
                int_val
              }
            }
          }
        `),
        collectSubscriptionData(`
          subscription {
            users {
              operation
              data {
                user_id
                name
                active
              }
            }
          }
        `)
      ]);

      // Verify all_types data
      expect(dataTypesResults.length).toBe(1);
      expect(dataTypesResults[0].data.all_types.data.int_val).toBe(100);

      // Verify users data
      expect(usersResults.length).toBe(2);
      const usersData = usersResults.map(r => r.data.users.data);
      
      // Check if we received the users
      const alice = usersData.find(u => u.user_id === 1);
      const bob = usersData.find(u => u.user_id === 2);
      
      expect(alice).toBeDefined();
      expect(alice.name).toBe('Alice');
      expect(alice.active).toBe(true);
      
      expect(bob).toBeDefined();
      expect(bob.name).toBe('Bob');
      expect(bob.active).toBe(false);
    });
  });

  describe('Complex Data Types', () => {
    it('should handle all PostgreSQL data types correctly', async () => {
      // Insert data with all types
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES 
          (1001, -32768, 2147483647, 9223372036854775807, 12345.6789, 3.14159, 2.718281828)
      `);
      
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES 
          (1, 'Test User', 'test@example.com', true, '2024-01-01 12:00:00', '2024-01-01 12:00:00+00', '{"nested": {"key": "value"}}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const results = await collectSubscriptionData(`
        subscription {
          all_types {
            operation
            data {
              id
              smallint_val
              int_val
              bigint_val
              decimal_val
              real_val
              double_val
            }
          }
        }
      `);

      expect(results.length).toBe(1);
      const data = results[0].data.all_types.data;
      
      // Verify ID is now integer
      expect(typeof data.id).toBe('number');
      expect(data.id).toBe(1001);
      
      // Verify numeric types
      expect(data.smallint_val).toBe(-32768);
      expect(data.int_val).toBe(2147483647);
      
      // BigInt should come as string in GraphQL
      expect(typeof data.bigint_val).toBe('string');
      expect(data.bigint_val).toBe('9223372036854775807');
      
      // DECIMAL comes as string since it's not in pg-types builtins
      expect(typeof data.decimal_val).toBe('string');
      expect(data.decimal_val).toBe('12345.6789');
      expect(typeof data.real_val).toBe('number');
      expect(data.real_val).toBeCloseTo(3.14159, 5);
      expect(typeof data.double_val).toBe('number');
      expect(data.double_val).toBeCloseTo(2.718281828, 9);
    });
  });

  describe('Error Handling', () => {
    it('should handle non-existent sources gracefully', async () => {
      const client = createWSClient();
      
      const errorPromise = new Promise((resolve, reject) => {
        client.subscribe(
          {
            query: `
              subscription {
                nonexistent_table {
                  operation
                  data {
                    id
                  }
                }
              }
            `
          },
          {
            next: () => reject(new Error('Should not receive data for non-existent table')),
            error: (err) => resolve(err),
            complete: () => reject(new Error('Should not complete for non-existent table')),
          }
        );
      });
      
      // Should receive an error
      await expect(errorPromise).resolves.toBeDefined();
      client.dispose();
    });
  });

  describe('UPDATE and DELETE Operations', () => {
    it('should handle UPDATE operations correctly', async () => {
      // Insert initial data
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES (1, 'Alice', 'alice@example.com', true, NOW(), NOW(), '{"role": "user"}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start subscription
      const client = createWSClient();
      const results: any[] = [];
      
      client.subscribe(
        {
          query: `
            subscription {
              users {
                operation
                data {
                  user_id
                  name
                  email
                  active
                  metadata
                }
              }
            }
          `
        },
        {
          next: (data) => results.push(data),
          error: console.error,
          complete: () => {},
        }
      );

      // Wait for snapshot
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(results.length).toBe(1);
      expect(results[0].data.users.operation).toBe('INSERT');
      expect(results[0].data.users.data.name).toBe('Alice');

      // Update the user
      await pgClient.query(`
        UPDATE users 
        SET name = 'Alice Updated', 
            email = 'alice.updated@example.com',
            active = false,
            metadata = '{"role": "admin"}'
        WHERE user_id = 1
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should have received the update
      expect(results.length).toBe(2);
      expect(results[1].data.users.operation).toBe('UPDATE');
      expect(results[1].data.users.data.user_id).toBe(1);
      expect(results[1].data.users.data.name).toBe('Alice Updated');
      expect(results[1].data.users.data.email).toBe('alice.updated@example.com');
      expect(results[1].data.users.data.active).toBe(false);
      
      client.dispose();
    });

    it('should handle DELETE operations correctly', async () => {
      // Insert initial data
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES 
          (1001, 10, 100, 1000000, 9.99, 1.5, 2.25),
          (1002, 20, 200, 2000000, 19.99, 3.0, 4.5)
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Start subscription
      const client = createWSClient();
      const results: any[] = [];
      
      client.subscribe(
        {
          query: `
            subscription {
              all_types {
                operation
                data {
                  id
                  int_val
                }
              }
            }
          `
        },
        {
          next: (data) => results.push(data),
          error: console.error,
          complete: () => {},
        }
      );

      // Wait for snapshot
      await new Promise(resolve => setTimeout(resolve, 1000));
      expect(results.length).toBe(2); // Two inserts

      // Delete one record
      await pgClient.query(`
        DELETE FROM all_types WHERE id = 1001
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Should have received the delete
      const deleteEvents = results.filter(r => r.data.all_types.operation === 'DELETE');
      expect(deleteEvents.length).toBe(1);
      expect(deleteEvents[0].data.all_types.data).toBeNull();
      
      client.dispose();
    });
  });

  describe('Late Joiners', () => {
    it('should receive proper snapshot when subscribing after data exists', async () => {
      // Insert data BEFORE subscription
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES 
          (1, 'Alice', 'alice@example.com', true, NOW(), NOW(), '{"role": "admin"}'),
          (2, 'Bob', 'bob@example.com', false, NOW(), NOW(), '{"role": "user"}'),
          (3, 'Charlie', 'charlie@example.com', true, NOW(), NOW(), '{"role": "user"}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Now subscribe - should get all 3 records as snapshot
      const results = await collectSubscriptionData(`
        subscription {
          users {
            operation
            data {
              user_id
              name
              active
            }
          }
        }
      `, {}, 2000);

      // Should receive 3 INSERT operations from snapshot
      expect(results.length).toBe(3);
      expect(results.every(r => r.data.users.operation === 'INSERT')).toBe(true);
      
      const userIds = results.map(r => r.data.users.data.user_id).sort();
      expect(userIds).toEqual([1, 2, 3]);
    });
  });

  describe('Multiple Concurrent Connections', () => {
    it('should handle multiple WebSocket clients concurrently', async () => {
      // Insert initial data
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES (1001, 10, 100, 1000000, 9.99, 1.5, 2.25)
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Create 5 concurrent clients
      const clients: WSClient[] = [];
      const results: any[][] = [];
      
      for (let i = 0; i < 5; i++) {
        const client = createWSClient();
        clients.push(client);
        results[i] = [];
        
        client.subscribe(
          {
            query: `
              subscription {
                all_types {
                  operation
                  data {
                    id
                    int_val
                  }
                }
              }
            `
          },
          {
            next: (data) => results[i].push(data),
            error: console.error,
            complete: () => {},
          }
        );
      }

      // Wait for all clients to receive snapshot
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // All clients should have received the snapshot
      for (let i = 0; i < 5; i++) {
        expect(results[i].length).toBe(1);
        expect(results[i][0].data.all_types.data.int_val).toBe(100);
      }

      // Insert new data - all clients should receive it
      await pgClient.query(`
        INSERT INTO all_types (id, smallint_val, int_val, bigint_val, decimal_val, real_val, double_val) 
        VALUES (1002, 20, 200, 2000000, 19.99, 3.0, 4.5)
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // All clients should have received the new insert
      for (let i = 0; i < 5; i++) {
        expect(results[i].length).toBe(2);
        expect(results[i][1].data.all_types.data.int_val).toBe(200);
      }

      // Clean up all clients
      clients.forEach(client => client.dispose());
    });
  });

  describe('Complex Operation Sequences', () => {
    it('should handle insert → update → delete → re-insert sequence', async () => {
      const client = createWSClient();
      const results: any[] = [];
      const userId = 42;
      
      client.subscribe(
        {
          query: `
            subscription {
              users {
                operation
                data {
                  user_id
                  name
                  active
                }
              }
            }
          `
        },
        {
          next: (data) => results.push(data),
          error: console.error,
          complete: () => {},
        }
      );

      // Wait for subscription to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // 1. INSERT
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES (${userId}, 'Test User', 'test@example.com', true, NOW(), NOW(), '{}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const insertIndex = results.length - 1;
      expect(results[insertIndex].data.users.operation).toBe('INSERT');
      expect(results[insertIndex].data.users.data.user_id).toBe(userId);
      expect(results[insertIndex].data.users.data.name).toBe('Test User');

      // 2. UPDATE
      await pgClient.query(`
        UPDATE users SET name = 'Updated User', active = false WHERE user_id = ${userId}
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const updateIndex = results.length - 1;
      expect(results[updateIndex].data.users.operation).toBe('UPDATE');
      expect(results[updateIndex].data.users.data.name).toBe('Updated User');
      expect(results[updateIndex].data.users.data.active).toBe(false);

      // 3. DELETE
      await pgClient.query(`DELETE FROM users WHERE user_id = ${userId}`);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const deleteIndex = results.length - 1;
      expect(results[deleteIndex].data.users.operation).toBe('DELETE');
      expect(results[deleteIndex].data.users.data).toBeNull();

      // 4. RE-INSERT with same ID
      await pgClient.query(`
        INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) 
        VALUES (${userId}, 'Reborn User', 'reborn@example.com', true, NOW(), NOW(), '{}')
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      const reinsertIndex = results.length - 1;
      expect(results[reinsertIndex].data.users.operation).toBe('INSERT');
      expect(results[reinsertIndex].data.users.data.user_id).toBe(userId);
      expect(results[reinsertIndex].data.users.data.name).toBe('Reborn User');

      client.dispose();
    });
  });

  describe('All Types Table', () => {
    it('should handle all PostgreSQL types in a single table', async () => {
      // Insert comprehensive type data
      await pgClient.query(`
        INSERT INTO all_types (
          id, bool_val, smallint_val, int_val, bigint_val, 
          decimal_val, numeric_val, real_val, double_val,
          char_val, varchar_val, text_val, uuid_val,
          date_val, time_val, timestamp_val, timestamptz_val,
          json_val, jsonb_val
        ) VALUES (
          1, true, 32767, 2147483647, 9223372036854775807,
          12345.67, 98765.4321, 3.14159, 2.718281828,
          'CHAR TEST', 'VARCHAR TEST', 'This is a longer text field with special chars: áéíóú',
          '550e8400-e29b-41d4-a716-446655440001',
          '2024-01-15', '14:30:00', '2024-01-15 14:30:00', '2024-01-15 14:30:00+00',
          '{"key": "value", "nested": {"array": [1, 2, 3]}}',
          '{"jsonb": true, "number": 42}'
        )
      `);
      await new Promise(resolve => setTimeout(resolve, 1000));

      const results = await collectSubscriptionData(`
        subscription {
          all_types {
            operation
            data {
              id
              bool_val
              smallint_val
              int_val
              bigint_val
              decimal_val
              numeric_val
              real_val
              double_val
              char_val
              varchar_val
              text_val
              uuid_val
              date_val
              time_val
              timestamp_val
              timestamptz_val
              json_val
              jsonb_val
            }
          }
        }
      `);

      expect(results.length).toBe(1);
      const data = results[0].data.all_types.data;

      // Verify all types
      expect(data.id).toBe(1);
      expect(data.bool_val).toBe(true);
      expect(data.smallint_val).toBe(32767);
      expect(data.int_val).toBe(2147483647);
      expect(typeof data.bigint_val).toBe('string');
      expect(data.bigint_val).toBe('9223372036854775807');
      // DECIMAL comes as string since it's not in pg-types builtins
      expect(typeof data.decimal_val).toBe('string');
      expect(data.decimal_val).toBe('12345.67');
      expect(data.numeric_val).toBeCloseTo(98765.4321, 4);
      expect(data.real_val).toBeCloseTo(3.14159, 5);
      expect(data.double_val).toBeCloseTo(2.718281828, 9);
      expect(data.char_val.trim()).toBe('CHAR TEST'); // CHAR type pads with spaces
      expect(data.varchar_val).toBe('VARCHAR TEST');
      expect(data.text_val).toBe('This is a longer text field with special chars: áéíóú');
      expect(data.uuid_val).toBe('550e8400-e29b-41d4-a716-446655440001');
      expect(data.date_val).toMatch(/2024-01-15/);
      expect(data.time_val).toMatch(/14:30:00/);
      expect(data.timestamp_val).toMatch(/2024-01-15.*14:30:00/);
      expect(data.timestamptz_val).toMatch(/2024-01-15.*14:30:00/);
      expect(typeof data.json_val).toBe('string');
      expect(typeof data.jsonb_val).toBe('string');
      expect(JSON.parse(data.json_val).nested.array).toEqual([1, 2, 3]);
      expect(JSON.parse(data.jsonb_val).number).toBe(42);
    });
  });
});