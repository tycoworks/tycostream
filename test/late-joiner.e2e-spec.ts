import * as path from 'path';
import { TestEnvironment, TestClient } from './utils/index.js';

// One statement writes every row, so they all share one Materialize timestamp,
// and the snapshot reaches tycostream in many chunks. It's large so that a
// shared cache took seconds to load it, which kept the window open.
const ROW_COUNT = 500000;

// The clients only watch every 5,000th row, so they stay fast however much
// of the view tycostream reads.
const WATCHED_IDS = Array.from({ length: 100 }, (_, i) => (i + 1) * 5000);

// The late clients join at these delays after the first one starts receiving,
// which landed inside that window.
const LATE_JOIN_DELAYS_MS = [0, 50, 100, 250, 500, 1000, 2000];

// A client that misses rows never completes, so cap the wait.
const COMPLETION_TIMEOUT_MS = 30000;

const QUERY = `
  subscription {
    stress_test(where: { id: { _in: [${WATCHED_IDS.join(', ')}] } }) {
      operation
      data {
        id
        value
        status
        department
      }
      fields
    }
  }
`;

function withTimeout(client: TestClient, label: string): Promise<void> {
  return Promise.race([
    client.waitForCompletion(),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        const { totalReceived, totalExpected } = client.getStats();
        reject(
          new Error(
            `${label} received ${totalReceived} of ${totalExpected} rows`,
          ),
        );
      }, COMPLETION_TIMEOUT_MS),
    ),
  ]);
}

describe('Late joiners', () => {
  let testEnv: TestEnvironment;

  beforeAll(async () => {
    testEnv = await TestEnvironment.create({
      appPort: 4003,
      schemaPath: path.join(import.meta.dirname, 'stress-test-schema.yaml'),
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

    await testEnv.executeSql(`
      CREATE TABLE stress_test (
        id INTEGER,
        value DOUBLE PRECISION,
        status TEXT,
        department TEXT
      )
    `);
    await testEnv.executeSql(`
      INSERT INTO stress_test
      SELECT g, g * 1.5, 'active', 'engineering'
      FROM generate_series(1, ${ROW_COUNT}) AS g
    `);
  }, 120000);

  afterAll(async () => {
    await testEnv.stop();
  });

  // Failed while tycostream shared one SUBSCRIBE and cache per view: a client
  // that joined between two chunks of the same timestamp never got the later
  // chunks. Each subscription now has its own SUBSCRIBE and snapshot.
  it('should give a client that joins mid-snapshot every row', async () => {
    const expectedState = new Map(
      WATCHED_IDS.map((id) => {
        return [
          id,
          {
            id,
            value: id * 1.5,
            status: 'active',
            department: 'engineering',
          },
        ];
      }),
    );
    const subscribe = async (name: string) => {
      const client = testEnv.createClient(name);
      await client.subscribe(name, {
        query: QUERY,
        expectedState,
        dataPath: 'stress_test',
        idField: 'id',
      });
      return client;
    };

    const first = await subscribe('first');

    // Wait until the first client's snapshot has started arriving. With a
    // shared cache, this was the window where late joiners lost rows.
    while (first.getStats().totalReceived === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // The late clients join just after
    const late = await Promise.all(
      LATE_JOIN_DELAYS_MS.map(
        (delay, i) =>
          new Promise<TestClient>((resolve) =>
            setTimeout(() => resolve(subscribe(`late-${i}`)), delay),
          ),
      ),
    );

    await withTimeout(first, 'The first client');
    await Promise.all(
      late.map((client, i) => withTimeout(client, `Late client ${i}`)),
    );
  }, 120000);
});
