import * as path from 'path';
import {
  TestEnvironment,
  TestClientManager
} from './utils';

describe('tycostream E2E', () => {
  let testEnv: TestEnvironment;
  let clientManager: TestClientManager;
  const testPort = 4001;
  const DEFAULT_LIVENESS_TIMEOUT = 30000; // 30 seconds

  beforeAll(async () => {
    // Bootstrap complete test environment
    testEnv = await TestEnvironment.create(
      testPort,
      path.join(__dirname, 'tycostream-schema.yaml')
    );

    // Create test tables matching our schema
    await testEnv.executeSql(`
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

    await testEnv.executeSql(`
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
    await testEnv.stop();
  });

  beforeEach(() => {
    // Client manager will be created in each test with appropriate configuration
  });

  afterEach(async () => {
    // Clean up client manager after each test
    if (clientManager) {
      clientManager.dispose();
    }
    
    // Clean up test data
    await testEnv.executeSql('DELETE FROM users');
    await testEnv.executeSql('DELETE FROM all_types');
  });

  describe('User subscriptions', () => {
    it('should receive real-time updates for users', async () => {
      // Define expected state after all operations
      const expectedState = new Map([
        [1, { user_id: 1, name: 'Alice', email: 'alice@example.com', active: true }],
        [2, { user_id: 2, name: 'Bob', email: 'bob@test.com', active: false }]
      ]);
      
      const receivedOperations: string[] = [];
      
      // Create and start the client
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClient({
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
        `,
        expectedState,
        dataPath: 'users',
        idField: 'user_id',
        onOperation: (operation) => {
          receivedOperations.push(operation);
        }
      });

      // Insert users
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name, email, active) VALUES (1, 'Alice', 'alice@test.com', true)"
      );

      await testEnv.executeSql(
        "INSERT INTO users (user_id, name, email, active) VALUES (2, 'Bob', 'bob@test.com', false)"
      );

      // Update a user
      await testEnv.executeSql(
        "UPDATE users SET email = 'alice@example.com' WHERE user_id = 1"
      );

      // Wait for all events
      await clientManager.waitForCompletion();

      // Verify operations received
      expect(receivedOperations).toEqual(['INSERT', 'INSERT', 'UPDATE']);
    }, 30000);

    it('should handle DELETE operations with row data', async () => {
      // Insert initial data
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name, email, active) VALUES (1001, 'ToDelete', 'delete@test.com', true)"
      );

      // Expected: empty state after delete
      const expectedState = new Map();
      let deleteEventReceived: any = null;
      
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClient({
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
        `,
        expectedState,
        dataPath: 'users',
        idField: 'user_id',
        onOperation: (operation, data) => {
          if (operation === 'DELETE') {
            deleteEventReceived = data;
          }
        }
      });

      // Wait for subscription to be ready
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Delete the user
      await testEnv.executeSql(
        "DELETE FROM users WHERE user_id = 1001"
      );

      // Wait for delete event
      await clientManager.waitForCompletion();

      // Verify DELETE operation includes row data (with nulls for non-key fields per Materialize behavior)
      expect(deleteEventReceived).not.toBeNull();
      expect(deleteEventReceived.user_id).toBe(1001);
      // Materialize sends NULL for non-key fields in DELETE operations
      expect(deleteEventReceived.name).toBeNull();
      expect(deleteEventReceived.email).toBeNull();
    }, 30000);
  });

  describe('Type handling', () => {
    it('should correctly handle all PostgreSQL types', async () => {
      let receivedData: any = null;
      
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClient({
        query: `
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
        expectedState: new Map([[1, { 
          id: 1, bool_val: true, smallint_val: 32767, int_val: 2147483647,
          bigint_val: '9223372036854775807', decimal_val: 123.45, numeric_val: 678.9,
          real_val: 1.23, double_val: 4.567890123456789, char_val: 'char      ',
          varchar_val: 'varchar value', text_val: 'text value',
          uuid_val: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          date_val: '2023-12-25', time_val: '13:45:30',
          timestamp_val: '2023-12-25 13:45:30', timestamptz_val: '2023-12-25 13:45:30+00',
          json_val: '{"key":"value"}', jsonb_val: '{"nested":{"key":"value"}}'
        }]]),
        dataPath: 'all_types',
        idField: 'id',
        onOperation: (operation, data) => {
          if (operation === 'INSERT') {
            receivedData = data;
          }
        }
      });

      // Insert with all types
      await testEnv.executeSql(`
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

      await clientManager.waitForCompletion();

      // Verify all types are correctly represented
      const data = receivedData;
      
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
      let receivedData: any = null;
      
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClient({
        query: `
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
        expectedState: new Map([[2, {
          id: 2,
          bool_val: null,
          text_val: null,
          timestamp_val: null,
          json_val: null
        }]]),
        dataPath: 'all_types',
        idField: 'id',
        onOperation: (operation, data) => {
          if (operation === 'INSERT') {
            receivedData = data;
          }
        }
      });

      // Insert with NULL values
      await testEnv.executeSql(
        "INSERT INTO all_types (id, bool_val, text_val, timestamp_val, json_val) VALUES (2, NULL, NULL, NULL, NULL)"
      );

      await clientManager.waitForCompletion();

      expect(receivedData.id).toBe(2);
      expect(receivedData.bool_val).toBeNull();
      expect(receivedData.text_val).toBeNull();
      expect(receivedData.timestamp_val).toBeNull();
      expect(receivedData.json_val).toBeNull();
    }, 30000);
  });

  describe('Multiple concurrent subscriptions', () => {
    it('should handle multiple clients subscribing to same source', async () => {
      // Override manager for this test - we need 2 clients
      if (clientManager) clientManager.dispose();
      
      let event1: any = null;
      let event2: any = null;
      
      // Create manager with configuration for 2 clients
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClients(2, 0, {
        query: `subscription { users { operation data { user_id name } } }`,
        expectedState: new Map([[100, { user_id: 100, name: 'Shared User' }]]),
        dataPath: 'users',
        idField: 'user_id',
        onOperation: (operation, data) => {
          // Track which client received the event
          if (!event1) {
            event1 = { operation, data };
          } else if (!event2) {
            event2 = { operation, data };
          }
        }
      });

      // Wait for subscriptions to establish
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Insert data
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name) VALUES (100, 'Shared User')"
      );

      // Wait for both clients to complete
      await clientManager.waitForCompletion();

      // Both clients should receive the same event
      expect(event1).not.toBeNull();
      expect(event2).not.toBeNull();
      expect(event1).toEqual(event2);
      expect(event1.operation).toBe('INSERT');
      expect(event1.data).toEqual({ user_id: 100, name: 'Shared User' });
    }, 30000);
  });

  describe('Late joiner functionality', () => {
    it('should receive current state when subscribing after data exists', async () => {
      // Insert data before creating subscription
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name, email, active) VALUES (1, 'Existing1', 'existing1@test.com', true)"
      );
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name, email, active) VALUES (2, 'Existing2', 'existing2@test.com', false)"
      );

      // Wait for Materialize to process
      await new Promise(resolve => setTimeout(resolve, 2000));

      const events: any[] = [];
      
      clientManager = new TestClientManager(testEnv.port, DEFAULT_LIVENESS_TIMEOUT);
      
      await clientManager.startClient({
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
        `,
        expectedState: new Map([
          [1, { user_id: 1, name: 'Existing1' }],
          [2, { user_id: 2, name: 'Existing2' }],
          [3, { user_id: 3, name: 'NewUser' }]
        ]),
        dataPath: 'users',
        idField: 'user_id',
        onOperation: (operation, data) => {
          events.push({ operation, data });
        }
      });

      // Wait for initial snapshot (should get 2 events immediately)
      await testEnv.waitUntil(() => events.length >= 2, 5000);

      // Verify we received the existing data as INSERT events
      const initialEvents = events.slice(0, 2);
      expect(initialEvents).toHaveLength(2);
      expect(initialEvents.every(e => e.operation === 'INSERT')).toBe(true);
      
      const userIds = initialEvents.map(e => e.data.user_id).sort();
      expect(userIds).toEqual([1, 2]);

      // Insert new data
      await testEnv.executeSql(
        "INSERT INTO users (user_id, name) VALUES (3, 'NewUser')"
      );

      // Wait for all events
      await clientManager.waitForCompletion();
      
      // Verify we got the new event
      expect(events).toHaveLength(3);
      expect(events[2].data.user_id).toBe(3);
      expect(events[2].data.name).toBe('NewUser');
    }, 30000);
  });
});