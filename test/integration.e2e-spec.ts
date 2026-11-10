import * as path from 'path';
import { TestEnvironment } from './utils/index.js';

describe('Integration Test', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    // Bootstrap complete test environment
    testEnv = await TestEnvironment.create({
      appPort: 4001,
      schemaPath: path.join(import.meta.dirname, 'integration-schema.yaml'),
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

  it('should drop the Materialize subscription as soon as an SSE client disconnects', async () => {
    const subscriptions = async () => {
      const [{ n }] = await testEnv.querySql<{ n: string }>(
        'SELECT count(*) AS n FROM mz_internal.mz_subscriptions',
      );
      return Number(n);
    };
    const before = await subscriptions();

    // A browser-style SSE subscription to a view that stays idle
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${testEnv.port}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        query: 'subscription { users { operation } }',
      }),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    await testEnv.waitUntil(async () => (await subscriptions()) > before);

    controller.abort();

    await testEnv.waitUntil(async () => (await subscriptions()) === before);
  }, 30000);

  it("should send one SSE message per timestamp: the snapshot, even when empty, then each later timestamp's updates together", async () => {
    type Updates = { operation: string; data: { user_id: number } }[];
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${testEnv.port}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({
        // Rows no other test writes, so the snapshot is empty
        query:
          'subscription { users(where: { user_id: { _gte: 8000, _lt: 9000 } }) { operation data { user_id } } }',
      }),
      signal: controller.signal,
    });
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffered = '';
    // The next SSE `next` message's updates, skipping keep-alives
    const nextMessage = async (): Promise<Updates> => {
      for (;;) {
        const end = buffered.indexOf('\n\n');
        if (end >= 0) {
          const message = buffered.slice(0, end);
          buffered = buffered.slice(end + 2);
          const data = message
            .split('\n')
            .find((line) => line.startsWith('data:'));
          if (message.startsWith('event: next') && data) {
            return (
              JSON.parse(data.slice('data:'.length)) as {
                data: { users: Updates };
              }
            ).data.users;
          }
          continue;
        }
        const { value, done } = await reader.read();
        if (done) {
          throw new Error('The stream ended');
        }
        buffered += value;
      }
    };

    try {
      expect(await nextMessage()).toEqual([]);

      // Two rows in one statement share a timestamp, so they arrive together
      await testEnv.executeSql(
        `INSERT INTO users (user_id, name) VALUES (8001, 'a'), (8002, 'b')`,
      );
      expect(
        (await nextMessage())
          .map((update) => [update.operation, update.data.user_id])
          .sort(),
      ).toEqual([
        ['INSERT', 8001],
        ['INSERT', 8002],
      ]);
    } finally {
      controller.abort();
    }
  }, 30000);

  describe('queries', () => {
    const graphql = (query: string, signal?: AbortSignal) =>
      fetch(`http://localhost:${testEnv.port}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
        signal,
      });

    it('should filter and return custom scalars, such as bigint, numeric, uuid, timestamps and jsonb, in their JSON forms', async () => {
      await testEnv.executeSql(`
        INSERT INTO all_types (id, smallint_val, bigint_val, numeric_val, double_val, uuid_val, timestamptz_val, timestamp_val, date_val, jsonb_val) VALUES
          (1, 7, 9007199254740991, 1234.5678, 2.5, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2026-01-01 09:30:00+02', '2026-01-01 09:30:00.5', '2026-01-02', '{"side": "buy", "lots": [1, 2]}'),
          (2, 8, 1, 0.5, 1.5, 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '2027-01-01 09:30:00+00', NULL, NULL, NULL)
      `);

      const response = await graphql(`
        {
          all_types(
            where: {
              bigint_val: { _eq: "9007199254740991" }
              numeric_val: { _gt: "1" }
              uuid_val: { _eq: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }
              timestamptz_val: { _lt: "2026-06-01T00:00:00Z" }
              smallint_val: { _in: [7] }
              double_val: { _gte: 2.5 }
            }
          ) {
            id
            bigint_val
            numeric_val
            uuid_val
            timestamptz_val
            timestamp_val
            date_val
            jsonb_val
          }
        }
      `);

      expect(await response.json()).toEqual({
        data: {
          all_types: [
            {
              id: 1,
              // JSON numbers, as Hasura sends them by default
              bigint_val: 9007199254740991,
              numeric_val: 1234.5678,
              uuid_val: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
              // ISO 8601, as Postgres writes timestamps in JSON
              timestamptz_val: '2026-01-01T07:30:00+00:00',
              timestamp_val: '2026-01-01T09:30:00.5',
              date_val: '2026-01-02',
              // JSON, not its text
              jsonb_val: { side: 'buy', lots: [1, 2] },
            },
          ],
        },
      });
    });

    it('should return the rows in order, up to the limit', async () => {
      await testEnv.executeSql(`
        INSERT INTO users (user_id, name) VALUES
          (9201, 'carol'), (9202, 'alice'), (9203, 'bob')
      `);

      const response = await graphql(`
        {
          users(
            where: { user_id: { _in: [9201, 9202, 9203] } }
            order_by: [{ name: asc }]
            limit: 2
          ) {
            name
          }
        }
      `);

      expect(await response.json()).toEqual({
        data: { users: [{ name: 'alice' }, { name: 'bob' }] },
      });
    });

    it("should return a source's current rows that match the filter, typed as the schema says", async () => {
      await testEnv.executeSql(`
        INSERT INTO users (user_id, name, active, rank) VALUES
          (9001, 'Query One', true, 'gold'),
          (9002, 'Query Two', false, 'bronze')
      `);

      const response = await graphql(`
        {
          users(
            where: { user_id: { _in: [9001, 9002] }, active: { _eq: true } }
          ) {
            user_id
            name
            active
            rank
          }
        }
      `);

      expect(await response.json()).toEqual({
        data: {
          users: [
            { user_id: 9001, name: 'Query One', active: true, rank: 'gold' },
          ],
        },
      });
    });

    it('should end a query in Materialize as soon as its client leaves', async () => {
      const queriesRunning = async () => {
        const [{ n }] = await testEnv.querySql<{ n: string }>(
          'SELECT count(*) AS n FROM mz_internal.mz_active_peeks',
        );
        return Number(n);
      };
      await testEnv.executeSql('CREATE TABLE slow_input (a INT)');
      await testEnv.executeSql(
        'INSERT INTO slow_input SELECT generate_series(1, 50000)',
      );
      await testEnv.executeSql(
        'CREATE VIEW slow_count AS SELECT count(*)::int AS id FROM slow_input x, slow_input y WHERE x.a < y.a',
      );

      const controller = new AbortController();
      const querying = graphql('{ slow_count { id } }', controller.signal);
      await testEnv.waitUntil(async () => (await queriesRunning()) > 0);

      controller.abort();
      await expect(querying).rejects.toThrow();

      // Well within the 30 s time limit that would otherwise end it
      await testEnv.waitUntil(async () => (await queriesRunning()) === 0);
    }, 30000);
  });
});
