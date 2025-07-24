import * as path from 'path';
import {
  TestContext,
  bootstrapTestEnvironment,
  cleanupTestEnvironment,
  createWebSocketClient,
  executeAndWait,
  collectSubscriptionEvents,
  waitForCondition
} from './e2e-test-utils';

describe('GraphQL Subscriptions E2E', () => {
  let testContext: TestContext;
  let wsClient: any | undefined;
  const testPort = 4001;

  beforeAll(async () => {
    // Bootstrap complete test environment
    testContext = await bootstrapTestEnvironment({
      appPort: testPort,
      schemaPath: path.join(__dirname, 'graphql-subscriptions-schema.yaml')
    });

    // Create test tables matching our schema
    await testContext.pgClient.query(`
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

    await testContext.pgClient.query(`
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
  }, 120000);

  afterAll(async () => {
    // Clean up WebSocket client
    if (wsClient) {
      await wsClient.dispose();
    }

    // Clean up test environment
    await cleanupTestEnvironment(testContext);
  });

  afterEach(async () => {
    // Clean up WebSocket client after each test
    if (wsClient) {
      await wsClient.dispose();
      wsClient = undefined;
    }
    
    // Clean up test data
    await testContext.pgClient.query('DELETE FROM users');
    await testContext.pgClient.query('DELETE FROM all_types');
    
    // Wait for Materialize to process deletions
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  describe('User subscriptions', () => {
    it('should receive real-time updates for users', async () => {
      wsClient = createWebSocketClient(testPort);

      // Subscribe to user updates
      const { events, promise } = collectSubscriptionEvents(
        wsClient,
        `
          subscription {
            users {
              operation
              data {
                user_id
                name
                email
                active
              }
            }
          }
        `,
        3 // We expect 3 events
      );

      // Insert users
      await executeAndWait(testContext.pgClient, 
        "INSERT INTO users (user_id, name, email, active) VALUES (1, 'Alice', 'alice@test.com', true)"
      );

      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name, email, active) VALUES (2, 'Bob', 'bob@test.com', false)"
      );

      // Update a user
      await executeAndWait(testContext.pgClient,
        "UPDATE users SET email = 'alice@example.com' WHERE user_id = 1"
      );

      // Wait for all events
      await promise;

      // Verify we received correct events
      expect(events).toHaveLength(3);
      
      // First insert
      expect(events[0].data.users.operation).toBe('INSERT');
      expect(events[0].data.users.data).toEqual({
        user_id: 1,
        name: 'Alice',
        email: 'alice@test.com',
        active: true
      });

      // Second insert
      expect(events[1].data.users.operation).toBe('INSERT');
      expect(events[1].data.users.data).toEqual({
        user_id: 2,
        name: 'Bob',
        email: 'bob@test.com',
        active: false
      });

      // Update
      expect(events[2].data.users.operation).toBe('UPDATE');
      expect(events[2].data.users.data).toEqual({
        user_id: 1,
        name: 'Alice',
        email: 'alice@example.com',
        active: true
      });
    }, 30000);

    it('should handle DELETE operations with row data', async () => {
      // Insert initial data
      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name, email, active) VALUES (1001, 'ToDelete', 'delete@test.com', true)"
      );

      // Create new client and subscribe
      wsClient = createWebSocketClient(testPort);

      const deleteEvents: any[] = [];
      let deleteReceived = false;

      wsClient.subscribe(
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
                }
              }
            }
          `
        },
        {
          next: (value: any) => {
            if (value.data.users.operation === 'DELETE') {
              deleteEvents.push(value);
              deleteReceived = true;
            }
          },
          error: (error: any) => {
            console.error('Subscription error:', error);
          },
          complete: () => {}
        }
      );

      // Wait for subscription to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Delete the user
      await executeAndWait(testContext.pgClient,
        "DELETE FROM users WHERE user_id = 1001"
      );

      // Wait for delete event
      await waitForCondition(() => deleteReceived);

      // Verify DELETE operation includes row data (with nulls for non-key fields per Materialize behavior)
      expect(deleteEvents).toHaveLength(1);
      expect(deleteEvents[0].data.users.operation).toBe('DELETE');
      expect(deleteEvents[0].data.users.data).not.toBeNull();
      expect(deleteEvents[0].data.users.data.user_id).toBe(1001);
      // Materialize sends NULL for non-key fields in DELETE operations
      expect(deleteEvents[0].data.users.data.name).toBeNull();
      expect(deleteEvents[0].data.users.data.email).toBeNull();
    }, 30000);
  });

  describe('Type handling', () => {
    it('should correctly handle all PostgreSQL types', async () => {
      wsClient = createWebSocketClient(testPort);

      const { events, promise } = collectSubscriptionEvents(
        wsClient,
        `
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
        `,
        1
      );

      // Insert with all types
      await executeAndWait(testContext.pgClient, `
        INSERT INTO all_types (
          id, bool_val, smallint_val, int_val, bigint_val,
          decimal_val, numeric_val, real_val, double_val,
          char_val, varchar_val, text_val, uuid_val,
          date_val, time_val, timestamp_val, timestamptz_val,
          json_val, jsonb_val
        ) VALUES (
          1, true, 32767, 2147483647, 9223372036854775807,
          123.45, 678.90, 1.23, 4.567890123456789,
          'char      ', 'varchar value', 'text value', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          '2023-12-25', '13:45:30', '2023-12-25 13:45:30', '2023-12-25 13:45:30+00',
          '{"key": "value"}', '{"nested": {"key": "value"}}'
        )
      `);

      await promise;

      // Verify all types are correctly represented
      const data = events[0].data.all_types.data;
      
      // Numeric types
      expect(data.id).toBe(1);
      expect(data.bool_val).toBe(true);
      expect(data.smallint_val).toBe(32767);
      expect(data.int_val).toBe(2147483647);
      expect(data.bigint_val).toBe('9223372036854775807'); // Bigint as string
      expect(data.decimal_val).toBe(123.45);
      expect(data.numeric_val).toBe(678.9);
      expect(data.real_val).toBeCloseTo(1.23, 2);
      expect(data.double_val).toBe(4.567890123456789);
      
      // String types
      expect(data.char_val).toBe('char      '); // Note: CHAR pads with spaces
      expect(data.varchar_val).toBe('varchar value');
      expect(data.text_val).toBe('text value');
      expect(data.uuid_val).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
      
      // Date/Time types (returned as strings)
      expect(data.date_val).toBe('2023-12-25');
      expect(data.time_val).toBe('13:45:30');
      expect(data.timestamp_val).toBe('2023-12-25 13:45:30'); // PostgreSQL format
      expect(data.timestamptz_val).toBe('2023-12-25 13:45:30+00');
      
      // JSON types (returned as strings - PostgreSQL removes spaces)
      expect(data.json_val).toBe('{"key":"value"}');
      expect(data.jsonb_val).toBe('{"nested":{"key":"value"}}');
    }, 30000);

    it('should handle NULL values correctly', async () => {
      wsClient = createWebSocketClient(testPort);

      const { events, promise } = collectSubscriptionEvents(
        wsClient,
        `
          subscription {
            all_types {
              operation
              data {
                id
                bool_val
                text_val
                timestamp_val
                json_val
              }
            }
          }
        `,
        1
      );

      // Insert with NULL values
      await executeAndWait(testContext.pgClient,
        "INSERT INTO all_types (id, bool_val, text_val, timestamp_val, json_val) VALUES (2, NULL, NULL, NULL, NULL)"
      );

      await promise;

      const data = events[0].data.all_types.data;
      expect(data.id).toBe(2);
      expect(data.bool_val).toBeNull();
      expect(data.text_val).toBeNull();
      expect(data.timestamp_val).toBeNull();
      expect(data.json_val).toBeNull();
    }, 30000);
  });

  describe('Multiple concurrent subscriptions', () => {
    it('should handle multiple clients subscribing to same source', async () => {
      const client1 = createWebSocketClient(testPort);
      const client2 = createWebSocketClient(testPort);

      const { events: events1 } = collectSubscriptionEvents(
        client1,
        `subscription { users { operation data { user_id name } } }`
      );

      const { events: events2 } = collectSubscriptionEvents(
        client2,
        `subscription { users { operation data { user_id name } } }`
      );

      // Wait for subscriptions to establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Insert data
      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name) VALUES (100, 'Shared User')"
      );

      // Wait for events to propagate
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Both clients should receive the same event
      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
      expect(events1[0]).toEqual(events2[0]);

      // Clean up
      client1.dispose();
      client2.dispose();
    }, 30000);
  });

  describe('Late joiner functionality', () => {
    it('should receive current state when subscribing after data exists', async () => {
      // Insert data before creating subscription
      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name, email, active) VALUES (1, 'Existing1', 'existing1@test.com', true)"
      );
      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name, email, active) VALUES (2, 'Existing2', 'existing2@test.com', false)"
      );

      // Wait for Materialize to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Now create subscription
      wsClient = createWebSocketClient(testPort);

      const initialEvents: any[] = [];
      let newEventReceived = false;

      wsClient.subscribe(
        {
          query: `
            subscription {
              users {
                operation
                data {
                  user_id
                  name
                }
              }
            }
          `
        },
        {
          next: (value: any) => {
            if (value.data.users.data.user_id <= 2) {
              initialEvents.push(value);
            } else {
              newEventReceived = true;
            }
          },
          error: (error: any) => {
            console.error('Subscription error:', error);
          },
          complete: () => {}
        }
      );

      // Wait for initial snapshot
      await waitForCondition(() => initialEvents.length >= 2, 5000);

      // Verify we received the existing data as INSERT events
      expect(initialEvents).toHaveLength(2);
      expect(initialEvents.every(e => e.data.users.operation === 'INSERT')).toBe(true);
      
      const userIds = initialEvents.map(e => e.data.users.data.user_id).sort();
      expect(userIds).toEqual([1, 2]);

      // Insert new data
      await executeAndWait(testContext.pgClient,
        "INSERT INTO users (user_id, name) VALUES (3, 'NewUser')"
      );

      // Wait for new event
      await waitForCondition(() => newEventReceived);
    }, 30000);
  });
});