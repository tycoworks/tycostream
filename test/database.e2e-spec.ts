import pg from 'pg';
import { ConfigService } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { MATERIALIZE_IMAGE } from './utils/index.js';
import { DatabaseConnectionService } from '../src/database/connection.service.js';
import { DatabaseService } from '../src/database/database.service.js';
import { MaterializeAdapter } from '../src/database/materialize.js';
import type { RowUpdateBatches } from '../src/database/types.js';
import type { DatabaseConfig } from '../src/config/database.config.js';
import type { SourceDefinition } from '../src/config/source.types.js';
import type {
  Row,
  RowUpdateBatch,
  RowUpdateEvent,
  WhereClause,
} from '../src/common/types.js';
import { DataType, RowUpdateType, StreamMode } from '../src/common/types.js';

// Each test reads its own table, so they don't see each other's rows
const tradesTable = (name: string): SourceDefinition => ({
  name,
  primaryKeyField: 'id',
  fields: [
    { name: 'id', dataType: DataType.Integer },
    { name: 'symbol', dataType: DataType.String },
    { name: 'qty', dataType: DataType.Float },
    { name: 'big', dataType: DataType.BigInt },
    { name: 'live', dataType: DataType.Boolean },
    { name: 'at', dataType: DataType.Timestamp },
  ],
});

// Short, so the test of the time limit is quick
const QUERY_TIMEOUT_MS = 2000;

const ALL_FIELDS = new Set(tradesTable('').fields.map((field) => field.name));

const sleep = (ms: number) =>
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

// The next batch, or a failure if none arrives in time
async function nextBatch(
  batches: RowUpdateBatches,
  timeoutMs = 10000,
): Promise<RowUpdateBatch> {
  const result = await Promise.race([batches.next(), sleep(timeoutMs)]);
  if (result === 'timeout') {
    throw new Error(`No batch within ${timeoutMs}ms`);
  }
  if (result.done) {
    throw new Error('The stream ended');
  }
  return result.value;
}

// The next batch's events
const nextEvents = async (batches: RowUpdateBatches) =>
  (await nextBatch(batches)).events;

const rowsById = (rows: Row[]) =>
  [...rows].sort((a, b) => (a.id as number) - (b.id as number));

const byId = (batch: RowUpdateEvent[]) =>
  [...batch].sort((a, b) => (a.row.id as number) - (b.row.id as number));

describe('DatabaseService on Materialize', () => {
  let container: StartedTestContainer;
  let admin: pg.Client;
  let config: DatabaseConfig;
  let connectionService: DatabaseConnectionService;
  let databaseService: DatabaseService;

  const sql = (statement: string) => admin.query(statement);
  const createTable = (name: string) =>
    sql(
      `CREATE TABLE ${name} (id INT, symbol TEXT, qty NUMERIC, big BIGINT, live BOOLEAN, at TIMESTAMP)`,
    );
  const subscribe = (source: SourceDefinition, where?: WhereClause) =>
    databaseService.stream(source, where, StreamMode.Live);
  // A snapshot stream's rows, collected
  const snapshotFrom = async (
    service: DatabaseService,
    source: SourceDefinition,
    where?: WhereClause,
  ) => {
    const rows: Row[] = [];
    for await (const batch of service.stream(
      source,
      where,
      StreamMode.Snapshot,
    )) {
      rows.push(...batch.events.map((event) => event.row));
    }
    return rows;
  };
  const snapshot = (source: SourceDefinition, where?: WhereClause) =>
    snapshotFrom(databaseService, source, where);
  const subscriptions = async () => {
    const result = await admin.query<{ n: string }>(
      'SELECT count(*) AS n FROM mz_internal.mz_subscriptions',
    );
    return Number(result.rows[0].n);
  };
  // Materialize drops a subscription shortly after its connection ends
  const waitForSubscriptions = async (expected: number) => {
    let count = await subscriptions();
    for (let i = 0; i < 50 && count !== expected; i++) {
      await sleep(100);
      count = await subscriptions();
    }
    return count;
  };

  beforeAll(async () => {
    container = await new GenericContainer(MATERIALIZE_IMAGE)
      .withExposedPorts(6875)
      .withEnvironment({ MZ_WORKERS: '1' })
      .withStartupTimeout(120000)
      .start();
    config = {
      host: container.getHost(),
      port: container.getMappedPort(6875),
      user: 'materialize',
      password: 'materialize',
      database: 'materialize',
      maxConnections: 4,
      queryTimeoutMs: QUERY_TIMEOUT_MS,
    };
    admin = new pg.Client(config);
    await admin.connect();
    connectionService = new DatabaseConnectionService({
      get: () => config,
    } as unknown as ConfigService);
    connectionService.onModuleInit();
    databaseService = new DatabaseService(
      connectionService,
      new MaterializeAdapter(),
    );
  }, 180000);

  afterAll(async () => {
    await connectionService?.onApplicationShutdown();
    await admin?.end();
    await container?.stop();
  });

  describe('live streams', () => {
    it('should send the snapshot as one batch of inserts, with values typed as the schema says', async () => {
      await createTable('snapshot');
      await sql(`INSERT INTO snapshot VALUES
        (1, 'AAPL', 1.5, 9007199254740993, true, '2026-01-01 09:30:00'),
        (2, 'MSFT', 20, 1, false, '2026-01-02 16:00:00'),
        (3, NULL, NULL, NULL, NULL, NULL)`);

      const batches = subscribe(tradesTable('snapshot'));
      try {
        expect(byId(await nextEvents(batches))).toEqual([
          {
            type: RowUpdateType.Insert,
            fields: ALL_FIELDS,
            row: {
              id: 1,
              symbol: 'AAPL',
              qty: 1.5,
              big: '9007199254740993',
              live: true,
              at: '2026-01-01 09:30:00',
            },
          },
          {
            type: RowUpdateType.Insert,
            fields: ALL_FIELDS,
            row: {
              id: 2,
              symbol: 'MSFT',
              qty: 20,
              big: '1',
              live: false,
              at: '2026-01-02 16:00:00',
            },
          },
          {
            type: RowUpdateType.Insert,
            fields: ALL_FIELDS,
            row: {
              id: 3,
              symbol: null,
              qty: null,
              big: null,
              live: null,
              at: null,
            },
          },
        ]);
      } finally {
        await batches.return();
      }
    });

    it('should send each later timestamp as its own complete batch of events', async () => {
      await createTable('changes');
      const batches = subscribe(tradesTable('changes'));
      try {
        // Two rows in one statement share a timestamp, so they arrive together
        await sql(
          `INSERT INTO changes (id, symbol, qty) VALUES (1, 'AAPL', 10), (2, 'MSFT', 20)`,
        );
        expect(
          byId(await nextEvents(batches)).map((e) => [e.row.id, e.type]),
        ).toEqual([
          [1, RowUpdateType.Insert],
          [2, RowUpdateType.Insert],
        ]);

        // An update arrives as a -1 and a +1, paired into one event
        await sql(`UPDATE changes SET qty = 15 WHERE id = 1`);
        expect(await nextEvents(batches)).toEqual([
          {
            type: RowUpdateType.Update,
            fields: new Set(['id', 'qty']),
            row: expect.objectContaining({ id: 1, qty: 15 }),
          },
        ]);

        await sql(`DELETE FROM changes WHERE id = 2`);
        expect(await nextEvents(batches)).toEqual([
          {
            type: RowUpdateType.Delete,
            fields: new Set(['id']),
            row: expect.objectContaining({ id: 2 }),
          },
        ]);
      } finally {
        await batches.return();
      }
    });

    it("should give each batch Materialize's timestamp, a later batch a later one", async () => {
      await createTable('stamped');
      await sql(`INSERT INTO stamped (id) VALUES (1)`);
      const batches = subscribe(tradesTable('stamped'));
      try {
        const snapshotBatch = await nextBatch(batches);
        await sql(`INSERT INTO stamped (id) VALUES (2)`);
        const later = await nextBatch(batches);

        expect(typeof snapshotBatch.timestamp).toBe('bigint');
        expect(later.timestamp! > snapshotBatch.timestamp!).toBe(true);
      } finally {
        await batches.return();
      }
    });

    it('should bind filter values as parameters', async () => {
      await createTable('params');
      const tricky = "x' or '1'='1";
      await sql(
        `INSERT INTO params (id, symbol) VALUES (1, 'AAPL'), (2, 'x'' or ''1''=''1')`,
      );

      const batches = subscribe(tradesTable('params'), {
        symbol: { _eq: tricky },
      });
      try {
        expect(
          (await nextEvents(batches)).map((e) => [e.row.id, e.row.symbol]),
        ).toEqual([[2, tricky]]);
      } finally {
        await batches.return();
      }
    });

    it('should send a row entering the filter as an insert and one leaving it as a delete', async () => {
      await createTable('filtered');
      await sql(`INSERT INTO filtered (id, qty) VALUES (1, 5)`);
      const batches = subscribe(tradesTable('filtered'), { qty: { _gt: 10 } });
      try {
        await sql(`UPDATE filtered SET qty = 50 WHERE id = 1`);
        expect((await nextEvents(batches)).map((e) => e.type)).toEqual([
          RowUpdateType.Insert,
        ]);

        await sql(`UPDATE filtered SET qty = 1 WHERE id = 1`);
        expect((await nextEvents(batches)).map((e) => e.type)).toEqual([
          RowUpdateType.Delete,
        ]);
      } finally {
        await batches.return();
      }
    });

    it('should send an empty snapshot of an empty source, then stay open while it is idle, and still send later changes', async () => {
      await createTable('idle');
      const batches = subscribe(tradesTable('idle'));
      try {
        const snapshotBatch = await nextBatch(batches);
        expect(snapshotBatch.events).toEqual([]);
        expect(typeof snapshotBatch.timestamp).toBe('bigint');

        const next = batches.next();
        expect(await Promise.race([next, sleep(4000)])).toBe('timeout');

        await sql(`INSERT INTO idle (id, symbol) VALUES (1, 'AAPL')`);
        const result = await Promise.race([next, sleep(10000)]);
        if (result === 'timeout' || result.done) {
          throw new Error('No batch after the insert');
        }
        expect(result.value.events.map((e) => [e.type, e.row.symbol])).toEqual([
          [RowUpdateType.Insert, 'AAPL'],
        ]);
      } finally {
        await batches.return();
      }
    });

    it('should fail only the stream whose source has a key that is not unique', async () => {
      await createTable('duplicates');
      await sql(
        `INSERT INTO duplicates (id, symbol) VALUES (1, 'AAPL'), (1, 'MSFT')`,
      );
      await createTable('unique_keys');
      await sql(`INSERT INTO unique_keys (id) VALUES (1)`);
      const duplicates = subscribe(tradesTable('duplicates'));
      const healthy = subscribe(tradesTable('unique_keys'));
      try {
        await expect(duplicates.next()).rejects.toThrow(/isn't unique/);
        expect((await nextEvents(healthy)).map((e) => e.row.id)).toEqual([1]);
      } finally {
        await duplicates.return();
        await healthy.return();
      }
      expect(await waitForSubscriptions(0)).toBe(0);
    });

    it('should outlast the idle-in-transaction timeout while the consumer is slow', async () => {
      await createTable('slow');
      await sql(`INSERT INTO slow (id) VALUES (1)`);
      // New sessions would be ended after a second idle in their transaction
      await sql(
        `ALTER ROLE materialize SET idle_in_transaction_session_timeout = '1s'`,
      );
      const batches = subscribe(tradesTable('slow'));
      try {
        await nextEvents(batches);
        // The consumer takes a while before it asks for more
        await sleep(3000);
        await sql(`INSERT INTO slow (id) VALUES (2)`);
        expect((await nextEvents(batches)).map((e) => e.row.id)).toEqual([2]);
      } finally {
        await batches.return();
        await sql(
          `ALTER ROLE materialize RESET idle_in_transaction_session_timeout`,
        );
      }
    });

    it('should leave out rows whose column is null, as SQL does, and reject null as a value', async () => {
      await createTable('nulls');
      await sql(
        `INSERT INTO nulls (id, symbol) VALUES (1, 'AAPL'), (2, 'MSFT'), (3, NULL)`,
      );
      const batches = subscribe(tradesTable('nulls'), {
        symbol: { _neq: 'AAPL' },
      });
      try {
        expect((await nextEvents(batches)).map((e) => e.row.id)).toEqual([2]);
      } finally {
        await batches.return();
      }
      expect(() =>
        subscribe(tradesTable('nulls'), { symbol: { _eq: null } }),
      ).toThrow("use '_is_null'");
    });

    it('should drop the subscription in Materialize when the consumer stops', async () => {
      await createTable('cleanup');
      await sql(`INSERT INTO cleanup (id) VALUES (1)`);
      expect(await subscriptions()).toBe(0);

      const batches = subscribe(tradesTable('cleanup'));
      await nextEvents(batches);
      expect(await subscriptions()).toBe(1);

      await batches.return();
      expect(await waitForSubscriptions(0)).toBe(0);
    });

    it('should close at once for a subscriber that leaves while still connecting', async () => {
      await createTable('early');
      const batches = subscribe(tradesTable('early'));
      void batches.next().catch(() => {});

      // A connection ended this early never finishes connecting
      const started = Date.now();
      await batches.return();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await waitForSubscriptions(0)).toBe(0);
    });

    it('should close every open stream on shutdown', async () => {
      await createTable('shutdown');
      await sql(`INSERT INTO shutdown (id) VALUES (1)`);
      const first = subscribe(tradesTable('shutdown'));
      const second = subscribe(tradesTable('shutdown'));
      await nextEvents(first);
      await nextEvents(second);
      expect(await subscriptions()).toBe(2);

      await databaseService.onModuleDestroy();
      expect(await waitForSubscriptions(0)).toBe(0);
      expect((await first.next()).done).toBe(true);
    });

    it('should reject an invalid filter before opening a connection', () => {
      expect(() =>
        subscribe(tradesTable('anything'), { no_such_field: { _eq: 1 } }),
      ).toThrow();
    });

    it('should fail only the stream whose source is missing', async () => {
      await createTable('healthy');
      await sql(`INSERT INTO healthy (id) VALUES (1)`);
      const missing = subscribe(tradesTable('no_such_view'));
      const healthy = subscribe(tradesTable('healthy'));
      try {
        await expect(missing.next()).rejects.toThrow(/unknown catalog item/);
        expect((await nextEvents(healthy)).map((r) => r.row.id)).toEqual([1]);
      } finally {
        await missing.return();
        await healthy.return();
      }
    });
  });

  describe('snapshots', () => {
    // A source whose rows take Materialize far longer to work out than the
    // time limit, so a snapshot of it is still running when it's cut off
    const slowSource: SourceDefinition = {
      name: 'slow_count',
      primaryKeyField: 'id',
      fields: [{ name: 'id', dataType: DataType.Integer }],
    };
    const queriesRunning = async () => {
      const result = await admin.query<{ n: string }>(
        'SELECT count(*) AS n FROM mz_internal.mz_active_peeks',
      );
      return Number(result.rows[0].n);
    };
    // Materialize stops a query shortly after its connection goes
    const waitForNoQueries = async () => {
      let count = await queriesRunning();
      for (let i = 0; i < 100 && count > 0; i++) {
        await sleep(100);
        count = await queriesRunning();
      }
      return count;
    };

    beforeAll(async () => {
      await sql('CREATE TABLE slow_input (a INT)');
      await sql('INSERT INTO slow_input SELECT generate_series(1, 50000)');
      await sql(
        'CREATE VIEW slow_count AS SELECT count(*)::int AS id FROM slow_input x, slow_input y WHERE x.a < y.a',
      );
    });

    it("should return the same typed rows as a live stream's snapshot", async () => {
      await createTable('queried');
      await sql(`INSERT INTO queried VALUES
        (1, 'AAPL', 1.5, 9007199254740993, true, '2026-01-01 09:30:00'),
        (2, NULL, NULL, NULL, NULL, NULL),
        (3, 'MSFT', 20, 1, false, '2026-01-02 16:00:00')`);
      const where: WhereClause = { id: { _lt: 3 } };

      const batches = subscribe(tradesTable('queried'), where);
      try {
        const liveSnapshot = (await nextEvents(batches)).map(
          (event) => event.row,
        );
        const rows = await snapshot(tradesTable('queried'), where);

        expect(rowsById(rows)).toEqual(rowsById(liveSnapshot));
        expect(rowsById(rows)).toEqual([
          {
            id: 1,
            symbol: 'AAPL',
            qty: 1.5,
            big: '9007199254740993',
            live: true,
            at: '2026-01-01 09:30:00',
          },
          { id: 2, symbol: null, qty: null, big: null, live: null, at: null },
        ]);
      } finally {
        await batches.return();
      }
    });

    it('should give an empty source as one empty batch, with no timestamp', async () => {
      await createTable('query_empty');
      const batches: RowUpdateBatch[] = [];
      for await (const batch of databaseService.stream(
        tradesTable('query_empty'),
        undefined,
        StreamMode.Snapshot,
      )) {
        batches.push(batch);
      }

      expect(batches).toEqual([{ events: [] }]);
    });

    it('should bind filter values as parameters', async () => {
      await createTable('query_params');
      const tricky = "x' or '1'='1";
      await sql(
        `INSERT INTO query_params (id, symbol) VALUES (1, 'AAPL'), (2, 'x'' or ''1''=''1')`,
      );

      const rows = await snapshot(tradesTable('query_params'), {
        symbol: { _eq: tricky },
      });

      expect(rows.map((row) => row.id)).toEqual([2]);
    });

    it('should cut off a snapshot over the time limit, and Materialize stops it', async () => {
      const started = Date.now();
      await expect(snapshot(slowSource)).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(Date.now() - started).toBeLessThan(QUERY_TIMEOUT_MS + 2000);
      expect(await waitForNoQueries()).toBe(0);

      // The next snapshot gets a fresh connection
      await createTable('after_timeout');
      expect(await snapshot(tradesTable('after_timeout'))).toEqual([]);
    });

    it('should end a snapshot whose client leaves, and Materialize stops it', async () => {
      const batches = databaseService.stream(
        slowSource,
        undefined,
        StreamMode.Snapshot,
      );
      void batches.next();
      await sleep(500);

      const started = Date.now();
      await batches.return();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(await waitForNoQueries()).toBe(0);
    });

    it('should fail a snapshot of a missing source', async () => {
      await expect(snapshot(tradesTable('no_such_table'))).rejects.toThrow(
        /unknown catalog item/,
      );
    });
  });

  describe('the connection cap', () => {
    it('should make a stream beyond DATABASE_MAX_CONNECTIONS wait for a free connection, then fail, in either mode', async () => {
      // Its own service, capped at two, with no time limit to get in first
      const capped = new DatabaseConnectionService({
        get: () => ({ ...config, maxConnections: 2, queryTimeoutMs: 60000 }),
      } as unknown as ConfigService);
      capped.onModuleInit();
      const service = new DatabaseService(capped, new MaterializeAdapter());
      await createTable('capped');
      await sql(`INSERT INTO capped (id) VALUES (1)`);
      const first = service.stream(
        tradesTable('capped'),
        undefined,
        StreamMode.Live,
      );
      const second = service.stream(
        tradesTable('capped'),
        undefined,
        StreamMode.Live,
      );
      try {
        // Both connections are held
        await nextEvents(first);
        await nextEvents(second);

        // pg's error when no connection comes free in time
        const NO_FREE_CONNECTION = 'timeout exceeded when trying to connect';
        const started = Date.now();
        const live = service.stream(
          tradesTable('capped'),
          undefined,
          StreamMode.Live,
        );
        await Promise.all([
          expect(live.next()).rejects.toThrow(NO_FREE_CONNECTION),
          expect(snapshotFrom(service, tradesTable('capped'))).rejects.toThrow(
            NO_FREE_CONNECTION,
          ),
        ]);
        // They waited for a free connection, for the connect timeout
        expect(Date.now() - started).toBeGreaterThanOrEqual(9000);

        // Once a stream ends, its connection is free again
        await first.return();
        expect(
          (await snapshotFrom(service, tradesTable('capped'))).map(
            (row) => row.id,
          ),
        ).toEqual([1]);
      } finally {
        await first.return();
        await second.return();
        await capped.onApplicationShutdown();
      }
    }, 30000);
  });
});
