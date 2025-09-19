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
        workers: '1'
      },
      graphqlUI: false,
      logLevel: 'error',
      webhook: {
        port: 3001
      }
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
    
    // Create table for testing triggers
    await testEnv.executeSql(`
      CREATE TABLE user_scores (
        user_id INTEGER,
        score INTEGER,
        active BOOLEAN
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
    
    // Final expected state - only active users should be visible
    const expectedState = new Map([
      // From initial operations (Alice is platinum rank)
      [1, { user_id: 1, name: 'Alice Updated', email: 'alice@example.com', active: true, rank: 'platinum' }],

      // From concurrent test (no email field provided, so it's null)
      [100, { user_id: 100, name: 'Shared User', email: null, active: true, rank: 'silver' }],

      // From late joiner test
      [1000, { user_id: 1000, name: 'LateJoiner1', email: 'late1@test.com', active: true, rank: 'gold' }],
      [1002, { user_id: 1002, name: 'LateJoiner3', email: 'late3@test.com', active: true, rank: 'silver' }]
    ]);
    
    // Create a client and add subscription for active users
    const client = testEnv.createClient('integration-test-client');
    
    await client.subscribe('active-users', {
      query: `
        subscription {
          users(where: { active: { _eq: true } }) {
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
      idField: 'user_id'
    });

    // === BASIC OPERATIONS ===
    // Insert users - one active platinum, one inactive bronze
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1, 'Alice', 'alice@test.com', true, 'platinum')"
    );

    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (2, 'Bob', 'bob@test.com', false, 'bronze')"
    );

    // Update the active user - test multi-field updates
    await testEnv.executeSql(
      "UPDATE users SET name = 'Alice Updated', email = 'alice@example.com' WHERE user_id = 1"
    );

    // === DELETE OPERATIONS ===
    // Insert and delete an active user
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active) VALUES (3, 'ToDelete', 'delete@test.com', true)"
    );
    
    await testEnv.executeSql(
      "DELETE FROM users WHERE user_id = 3"
    );

    // === VIEW ENTER/LEAVE ===
    // Test user entering view (inactive -> active)
    await testEnv.executeSql(
      "UPDATE users SET active = true WHERE user_id = 2"
    );
    
    // Test user leaving view (active -> inactive)
    await testEnv.executeSql(
      "UPDATE users SET active = false WHERE user_id = 2"
    );

    // === CONCURRENT OPERATIONS ===
    // Add a user that will be shared across "concurrent" scenarios
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, active, rank) VALUES (100, 'Shared User', true, 'silver')"
    );

    // === LATE JOINER SIMULATION ===
    // Insert data that would have existed before subscription
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1000, 'LateJoiner1', 'late1@test.com', true, 'gold')"
    );
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1001, 'LateJoiner2', 'late2@test.com', false, 'bronze')"
    );
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, rank) VALUES (1002, 'LateJoiner3', 'late3@test.com', true, 'silver')"
    );

    // === TYPE TESTING WITH NULL VALUES ===
    // Test various data types including NULL handling
    await testEnv.executeSql(
      "INSERT INTO users (user_id, name, email, active, created_at, updated_at, metadata) VALUES " +
      "(2000, 'TypeTest', NULL, true, '2023-12-25 13:45:30', '2023-12-25 13:45:30+00', '{\"key\": \"value\"}')"
    );
    
    // Update to test metadata changes  
    await testEnv.executeSql(
      "UPDATE users SET metadata = '{\"updated\": true}' WHERE user_id = 2000"
    );
    
    // Remove from view
    await testEnv.executeSql(
      "UPDATE users SET active = false WHERE user_id = 2000"
    );

    // Wait for all events to process and convergence
    await client.waitForCompletion();

    // The test passes if we converged to expectedState
    // No need for individual assertions - the framework handles state comparison
  }, 120000); // 2 minute timeout for comprehensive test
  
  it('should handle triggers with score threshold and hysteresis', async () => {
    // Test GraphQL triggers with webhook callbacks
    // Tests both hysteresis and overlapping fire/clear conditions:
    // - Fire when score >= 100
    // - Clear when score < 90 AND active = false (both conditions required)
    // This tests that CLEAR only fires when fire becomes false AND clear conditions are met
    
    // Expected webhook events in order
    // Each webhook will receive event_type (FIRE/CLEAR), trigger_name, timestamp, and data
    const expectedTriggerEvents = [
      { event_type: 'FIRE', trigger_name: 'score_threshold_trigger', data: { user_id: 1, score: 150, active: true }},
      { event_type: 'CLEAR', trigger_name: 'score_threshold_trigger', data: { user_id: 1, score: 80, active: false }},
      { event_type: 'FIRE', trigger_name: 'score_threshold_trigger', data: { user_id: 1, score: 120, active: true }},
      { event_type: 'FIRE', trigger_name: 'score_threshold_trigger', data: { user_id: 2, score: 200, active: true }},
      { event_type: 'CLEAR', trigger_name: 'score_threshold_trigger', data: { user_id: 1, score: null, active: null }}
    ];
    
    // Create a client and add trigger with overlapping conditions
    // Fire when score >= 100, clear when score < 90 AND active = false
    // Tests hysteresis (90-100 range) and compound clear conditions
    const client = testEnv.createClient('trigger-test-client');
    
    await client.trigger('score-threshold', {
      query: `
        mutation CreateScoreTrigger($webhookUrl: String!) {
          create_user_scores_trigger(input: {
            name: "score_threshold_trigger"
            webhook: $webhookUrl
            fire: {
              score: { _gte: 100 }
            }
            clear: {
              _and: [
                { score: { _lt: 90 } },
                { active: { _eq: false } }
              ]
            }
          }) {
            name
            webhook
          }
        }
      `,
      deleteQuery: `
        mutation DeleteScoreTrigger($name: String!) {
          delete_user_scores_trigger(name: $name) {
            name
          }
        }
      `,
      expectedEvents: expectedTriggerEvents,
      idField: 'event_id'
    });
    
    // Phase 1: Test trigger with various operations
    
    // User 1: Start below threshold
    await testEnv.executeSql(
      "INSERT INTO user_scores (user_id, score, active) VALUES (1, 50, true)"
    );
    
    // User 1: Cross threshold (should trigger)
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 150 WHERE user_id = 1"
    );
    
    // User 1: Update while above (should NOT trigger)
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 160 WHERE user_id = 1"
    );
    
    // User 1: Set active=false while score still high (should NOT trigger CLEAR)
    // because fire condition (score >= 100) is still true
    await testEnv.executeSql(
      "UPDATE user_scores SET active = false WHERE user_id = 1"
    );
    
    // User 1: Drop score below 90 while active=false (should trigger CLEAR)
    // because fire is false (score < 100) AND both clear conditions are met (score < 90 AND active = false)
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 80 WHERE user_id = 1"
    );
    
    // User 1: Increase score to hysteresis band (should NOT trigger)
    // score=95 is between 90-100, so neither fire (>=100) nor clear (<90 AND active=false) conditions are met
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 95 WHERE user_id = 1"
    );
    
    // User 1: Set active=true and score above threshold (should trigger FIRE)
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 120, active = true WHERE user_id = 1"
    );
    
    // User 2: Insert above threshold (should trigger)
    await testEnv.executeSql(
      "INSERT INTO user_scores (user_id, score, active) VALUES (2, 200, true)"
    );
    
    // User 2: Update while above (should NOT trigger)
    await testEnv.executeSql(
      "UPDATE user_scores SET score = 210 WHERE user_id = 2"
    );
    
    // User 3: Insert below threshold (should NOT trigger)
    await testEnv.executeSql(
      "INSERT INTO user_scores (user_id, score, active) VALUES (3, 50, false)"
    );
    
    // User 3: Delete while below (should NOT trigger)
    await testEnv.executeSql(
      "DELETE FROM user_scores WHERE user_id = 3"
    );
    
    // User 1: Delete while above threshold (should trigger)
    await testEnv.executeSql(
      "DELETE FROM user_scores WHERE user_id = 1"
    );
    
    // Wait for all trigger events to be received
    await client.waitForCompletion();
    
    // Phase 2: Test trigger deletion (would need mutation support)
    // TODO: Add trigger deletion test when delete mutation is available
    
  }, 120000); // 2 minute timeout
});