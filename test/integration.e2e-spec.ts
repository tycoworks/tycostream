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

  // A subscription over SSE, as a browser opens one, and its messages one at
  // a time: each `next` message's updates of the source, skipping keep-alives
  const subscribeOverSse = async <Update>(query: string, source: string) => {
    const controller = new AbortController();
    const response = await fetch(`http://localhost:${testEnv.port}/graphql`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify({ query }),
      signal: controller.signal,
    });
    const reader = response
      .body!.pipeThrough(new TextDecoderStream())
      .getReader();
    let buffered = '';
    const next = async (): Promise<Update[]> => {
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
                data: Record<string, Update[]>;
              }
            ).data[source];
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
    return { next, close: () => controller.abort() };
  };

  it("should send one SSE message per timestamp: the snapshot, even when empty, then each later timestamp's updates together", async () => {
    type Update = { operation: string; data: { user_id: number } };
    // Rows no other test writes, so the snapshot is empty
    const subscription = await subscribeOverSse<Update>(
      'subscription { users(where: { user_id: { _gte: 8000, _lt: 9000 } }) { operation data { user_id } } }',
      'users',
    );

    try {
      expect(await subscription.next()).toEqual([]);

      // Two rows in one statement share a timestamp, so they arrive together
      await testEnv.executeSql(
        `INSERT INTO users (user_id, name) VALUES (8001, 'a'), (8002, 'b')`,
      );
      expect(
        (await subscription.next())
          .map((update) => [update.operation, update.data.user_id])
          .sort(),
      ).toEqual([
        ['INSERT', 8001],
        ['INSERT', 8002],
      ]);
    } finally {
      subscription.close();
    }
  }, 30000);

  it('should send only the columns a subscription selects, so a change to any other column sends nothing', async () => {
    type Update = {
      operation: string;
      data: { id: number; name: string };
      fields: string[];
    };
    // Rows no other test writes. The columns are selected through an alias
    // and a fragment, as clients write them.
    const subscription = await subscribeOverSse<Update>(
      `subscription {
        users(where: { user_id: { _gte: 7000, _lt: 8000 } }) {
          operation
          data { id: user_id ...named }
          fields
        }
      }
      fragment named on users { name }`,
      'users',
    );

    try {
      expect(await subscription.next()).toEqual([]);

      await testEnv.executeSql(
        `INSERT INTO users (user_id, name, email) VALUES (7001, 'a', 'a@test.com')`,
      );
      expect(await subscription.next()).toEqual([
        {
          operation: 'INSERT',
          data: { id: 7001, name: 'a' },
          fields: ['user_id', 'name'],
        },
      ]);

      // email isn't selected, so its change sends nothing, and the next
      // message is name's change
      await testEnv.executeSql(
        `UPDATE users SET email = 'b@test.com' WHERE user_id = 7001`,
      );
      await testEnv.executeSql(
        `UPDATE users SET name = 'b' WHERE user_id = 7001`,
      );
      expect(await subscription.next()).toEqual([
        {
          operation: 'UPDATE',
          data: { id: 7001, name: 'b' },
          fields: ['user_id', 'name'],
        },
      ]);
    } finally {
      subscription.close();
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

    it('should return every served type as the database stores it, a char(n) without its trailing padding, and the text "null" apart from null', async () => {
      await testEnv.executeSql(`
        INSERT INTO all_types VALUES
          (3, true, 7, 2147483647, 9007199254740991, 0.1, 12345.678, 1.5, 0.25,
           'AAPL', 'v', 'null', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
           '2026-01-02', '09:30:00.25', '2026-01-01 09:30:00.5', '2026-01-01 09:30:00+02',
           '{"a": [1, null]}', '"str"'),
          (4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL, NULL)
      `);

      const response = await graphql(`
        {
          all_types(where: { id: { _in: [3, 4] } }, order_by: [{ id: asc }]) {
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
      `);

      expect(await response.json()).toEqual({
        data: {
          all_types: [
            {
              id: 3,
              bool_val: true,
              smallint_val: 7,
              int_val: 2147483647,
              bigint_val: 9007199254740991,
              decimal_val: 0.1,
              numeric_val: 12345.678,
              real_val: 1.5,
              double_val: 0.25,
              // Postgres drops a char(n)'s trailing padding when it writes it
              // as text
              char_val: 'AAPL',
              varchar_val: 'v',
              text_val: 'null',
              uuid_val: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
              date_val: '2026-01-02',
              time_val: '09:30:00.25',
              timestamp_val: '2026-01-01T09:30:00.5',
              timestamptz_val: '2026-01-01T07:30:00+00:00',
              json_val: { a: [1, null] },
              jsonb_val: 'str',
            },
            {
              id: 4,
              bool_val: null,
              smallint_val: null,
              int_val: null,
              bigint_val: null,
              decimal_val: null,
              numeric_val: null,
              real_val: null,
              double_val: null,
              char_val: null,
              varchar_val: null,
              text_val: null,
              uuid_val: null,
              date_val: null,
              time_val: null,
              timestamp_val: null,
              timestamptz_val: null,
              json_val: null,
              jsonb_val: null,
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

    describe('relationships', () => {
      beforeAll(async () => {
        await testEnv.executeSql(
          'CREATE TABLE positions (instrument_id INT, symbol TEXT, net_position BIGINT)',
        );
        await testEnv.executeSql('CREATE TABLE accounts (id INT, name TEXT)');
        await testEnv.executeSql(
          'CREATE TABLE trades (id INT, instrument_id INT, account_id INT, quantity INT)',
        );
        await testEnv.executeSql(`
          INSERT INTO positions VALUES (1, 'AAPL', 600), (2, 'MSFT', 0), (3, 'GOOG', 100)
        `);
        await testEnv.executeSql(`
          INSERT INTO accounts VALUES (1, 'Growth Fund'), (2, 'Income Fund')
        `);
        // Trade 9 has no account, and trade 10 no position
        await testEnv.executeSql(`
          INSERT INTO trades VALUES
            (5, 1, 1, 100), (7, 1, 2, 400), (8, 1, 1, 100),
            (9, 3, NULL, 100), (10, 4, 2, 50)
        `);
      });

      it("should nest each position's latest trades under it, each with its account, and give a position with none []", async () => {
        const response = await graphql(`
          {
            positions(order_by: [{ symbol: asc }]) {
              symbol
              net_position
              trades(order_by: [{ id: desc }], limit: 2) {
                id
                quantity
                accounts {
                  name
                }
              }
            }
          }
        `);

        expect(await response.json()).toEqual({
          data: {
            positions: [
              {
                symbol: 'AAPL',
                net_position: 600,
                trades: [
                  { id: 8, quantity: 100, accounts: { name: 'Growth Fund' } },
                  { id: 7, quantity: 400, accounts: { name: 'Income Fund' } },
                ],
              },
              {
                symbol: 'GOOG',
                net_position: 100,
                trades: [{ id: 9, quantity: 100, accounts: null }],
              },
              { symbol: 'MSFT', net_position: 0, trades: [] },
            ],
          },
        });
      });

      it("should give each trade its position, null when it has none, and that position's trades", async () => {
        const response = await graphql(`
          {
            trades(
              where: { id: { _in: [8, 9, 10] } }
              order_by: [{ id: asc }]
            ) {
              id
              positions {
                symbol
                trades(order_by: [{ id: asc }]) {
                  id
                }
              }
            }
          }
        `);

        expect(await response.json()).toEqual({
          data: {
            trades: [
              {
                id: 8,
                positions: {
                  symbol: 'AAPL',
                  trades: [{ id: 5 }, { id: 7 }, { id: 8 }],
                },
              },
              { id: 9, positions: { symbol: 'GOOG', trades: [{ id: 9 }] } },
              { id: 10, positions: null },
            ],
          },
        });
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
