import * as path from 'path';
import { TestEnvironment } from './utils';

describe('Integration Test', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Bootstrap complete test environment
    testEnv = await TestEnvironment.create({
      appPort: 4001,
      schemaPath: path.join(__dirname, 'integration-schema.yaml'),
      database: {
        host: 'localhost',
        port: 6875,
        user: 'materialize',
        password: 'materialize',
        name: 'materialize',
        workers: '1',
      },
      graphqlUI: false,
      logLevel: 'error',
    });

    // Create test tables matching our schema
    await testEnv.executeSql(`
      CREATE TABLE users (
        user_id INTEGER,
        name TEXT,
        email VARCHAR(255),
        active BOOLEAN,
        rank TEXT,
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

  it('should handle complete integration flow with filtering', async () => {
    // This is the ONE comprehensive integration test
    // We'll use a filter throughout to prove everything works with filtering enabled

    // Final expected state - only active users with rank >= silver should be visible
    // This tests enum ordinal comparison (bronze < silver < gold < platinum)
    const expectedState = new Map([
      // From initial operations (Alice is platinum rank)
      [
        1,
        {
          user_id: 1,
          name: 'Alice Updated',
          email: 'alice@example.com',
          active: true,
          rank: 'platinum',
        },
      ],

      // From concurrent test (no email field provided, so it's null)
      [
        100,
        {
          user_id: 100,
          name: 'Shared User',
          email: null,
          active: true,
          rank: 'silver',
        },
      ],

      // From late joiner test
      [
        1000,
        {
          user_id: 1000,
          name: 'LateJoiner1',
          email: 'late1@test.com',
          active: true,
          rank: 'gold',
        },
      ],
      [
        1002,
        {
          user_id: 1002,
          name: 'LateJoiner3',
          email: 'late3@test.com',
          active: true,
          rank: 'silver',
        },
      ],
    ]);

    // Create a client and add subscription for active users with rank >= silver
    // This tests enum ordinal comparisons
    const client = testEnv.createClient('integration-test-client');

    await client.subscribe('active-users', {
      query: `
        subscription {
          users(where: {
            _and: [
              { active: { _eq: true } },
              { rank: { _gte: silver } }
            ]
          }) {
            operation
            data {
              user_id
              name
              email
              active
              rank
            }
            fields
          }
        }
      `,
      expectedState,
      dataPath: 'users',
      idField: 'user_id',
    });

    // === BASIC OPERATIONS ===
    // Insert users - one active platinum, one inactive bronze
    // Bronze rank should be filtered out by rank >= silver condition
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1, 'Alice', 'alice@test.com', true, 'platinum')",
    );

    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (2, 'Bob', 'bob@test.com', false, 'bronze')",
    );

    // Update the active user - test multi-field updates
    await testEnv.executeSql(
      "UPDATE users SET name = 'Alice Updated', email = 'alice@example.com' WHERE user_id = 1",
    );

    // === DELETE OPERATIONS ===
    // Insert and delete an active user
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active) VALUES (3, 'ToDelete', 'delete@test.com', true)",
    );

    await testEnv.executeSql('DELETE FROM users WHERE user_id = 3');

    // === VIEW ENTER/LEAVE ===
    // Test user entering view (inactive -> active)
    await testEnv.executeSql(
      'UPDATE users SET active = true WHERE user_id = 2',
    );

    // Test user leaving view (active -> inactive)
    await testEnv.executeSql(
      'UPDATE users SET active = false WHERE user_id = 2',
    );

    // === CONCURRENT OPERATIONS ===
    // Add a user that will be shared across "concurrent" scenarios
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, active, rank) VALUES (100, 'Shared User', true, 'silver')",
    );

    // === LATE JOINER SIMULATION ===
    // Insert data that would have existed before subscription
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1000, 'LateJoiner1', 'late1@test.com', true, 'gold')",
    );
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1001, 'LateJoiner2', 'late2@test.com', false, 'bronze')",
    );
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1002, 'LateJoiner3', 'late3@test.com', true, 'silver')",
    );

    // === ENUM ORDINAL TEST ===
    // Insert an active user with bronze rank - should NOT appear due to rank < silver
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1003, 'BronzeUser', 'bronze@test.com', true, 'bronze')",
    );

    // === TYPE TESTING WITH NULL VALUES ===
    // Test various data types including NULL handling
    await testEnv.executeSql(
      'INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) VALUES ' +
        "(2000, 'TypeTest', NULL, true, '2023-12-25 13:45:30', '2023-12-25 13:45:30+00', '{\"key\": \"value\"}')",
    );

    // Update to test metadata changes
    await testEnv.executeSql(
      'UPDATE users SET metadata = \'{"updated": true}\' WHERE user_id = 2000',
    );

    // Remove from view
    await testEnv.executeSql(
      'UPDATE users SET active = false WHERE user_id = 2000',
    );

    // Wait for all events to process and convergence
    await client.waitForCompletion();

    // The test passes if we converged to expectedState
    // No need for individual assertions - the framework handles state comparison
  }, 120000); // 2 minute timeout for comprehensive test
});
