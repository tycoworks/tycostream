import pg from 'pg';
import { ConfigService } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { MATERIALIZE_IMAGE } from './utils/index.js';
import { DatabaseConnectionService } from '../src/database/connection.service.js';
import { DatabaseStreamService } from '../src/database/stream.service.js';
import type { ChangeBatches } from '../src/database/types.js';
import type { DatabaseConfig } from '../src/config/database.config.js';
import type { SourceDefinition } from '../src/config/source.types.js';
import type { RowUpdateEvent, WhereClause } from '../src/common/types.js';
import { DataType, RowUpdateType } from '../src/common/types.js';

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

const ALL_FIELDS = new Set(tradesTable('').fields.map((field) => field.name));

const sleep = (ms: number) =>
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), ms));

// The next batch, or a failure if none arrives in time
async function nextBatch(
  batches: ChangeBatches,
  timeoutMs = 10000,
): Promise<RowUpdateEvent[]> {
  const result = await Promise.race([batches.next(), sleep(timeoutMs)]);
  if (result === 'timeout') {
    throw new Error(`No batch within ${timeoutMs}ms`);
  }
  if (result.done) {
    throw new Error('The subscription ended');
  }
  return result.value;
}

const byId = (batch: RowUpdateEvent[]) =>
  [...batch].sort((a, b) => (a.row.id as number) - (b.row.id as number));

describe('Database streams on Materialize', () => {
  let container: StartedTestContainer;
  let admin: pg.Client;
  let connectionService: DatabaseConnectionService;
  let streams: DatabaseStreamService;

  const sql = (statement: string) => admin.query(statement);
  const createTable = (name: string) =>
    sql(
      `CREATE TABLE ${name} (id INT, symbol TEXT, qty NUMERIC, big BIGINT, live BOOLEAN, at TIMESTAMP)`,
    );
  const subscribe = (source: SourceDefinition, where?: WhereClause) =>
    streams.subscribe(source, where);
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
    const config: DatabaseConfig = {
      host: container.getHost(),
      port: container.getMappedPort(6875),
      user: 'materialize',
      password: 'materialize',
      database: 'materialize',
    };
    admin = new pg.Client(config);
    await admin.connect();
    connectionService = new DatabaseConnectionService({
      get: () => config,
    } as unknown as ConfigService);
    connectionService.onModuleInit();
    streams = new DatabaseStreamService(connectionService);
  }, 180000);

  afterAll(async () => {
    await admin?.end();
    await container?.stop();
  });

  it('should send the snapshot as one batch of inserts, with values typed as the schema says', async () => {
    await createTable('snapshot');
    await sql(`INSERT INTO snapshot VALUES
      (1, 'AAPL', 1.5, 9007199254740993, true, '2026-01-01 09:30:00'),
      (2, 'MSFT', 20, 1, false, '2026-01-02 16:00:00'),
      (3, NULL, NULL, NULL, NULL, NULL)`);

    const batches = subscribe(tradesTable('snapshot'));
    try {
      expect(byId(await nextBatch(batches))).toEqual([
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
        byId(await nextBatch(batches)).map((e) => [e.row.id, e.type]),
      ).toEqual([
        [1, RowUpdateType.Insert],
        [2, RowUpdateType.Insert],
      ]);

      // An update arrives as a -1 and a +1, paired into one event
      await sql(`UPDATE changes SET qty = 15 WHERE id = 1`);
      expect(await nextBatch(batches)).toEqual([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'qty']),
          row: expect.objectContaining({ id: 1, qty: 15 }),
        },
      ]);

      await sql(`DELETE FROM changes WHERE id = 2`);
      expect(await nextBatch(batches)).toEqual([
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
        (await nextBatch(batches)).map((e) => [e.row.id, e.row.symbol]),
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
      expect((await nextBatch(batches)).map((e) => e.type)).toEqual([
        RowUpdateType.Insert,
      ]);

      await sql(`UPDATE filtered SET qty = 1 WHERE id = 1`);
      expect((await nextBatch(batches)).map((e) => e.type)).toEqual([
        RowUpdateType.Delete,
      ]);
    } finally {
      await batches.return();
    }
  });

  it('should stay open while the view is idle, and still send later changes', async () => {
    await createTable('idle');
    const batches = subscribe(tradesTable('idle'));
    try {
      const next = batches.next();
      expect(await Promise.race([next, sleep(4000)])).toBe('timeout');

      await sql(`INSERT INTO idle (id, symbol) VALUES (1, 'AAPL')`);
      const result = await Promise.race([next, sleep(10000)]);
      expect(result).not.toBe('timeout');
      expect(
        (result as IteratorResult<RowUpdateEvent[]>).value.map((e) => [
          e.type,
          e.row.symbol,
        ]),
      ).toEqual([[RowUpdateType.Insert, 'AAPL']]);
    } finally {
      await batches.return();
    }
  });

  it('should fail only the subscription whose view has a key that is not unique', async () => {
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
      expect((await nextBatch(healthy)).map((e) => e.row.id)).toEqual([1]);
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
      await nextBatch(batches);
      // The consumer takes a while before it asks for more
      await sleep(3000);
      await sql(`INSERT INTO slow (id) VALUES (2)`);
      expect((await nextBatch(batches)).map((e) => e.row.id)).toEqual([2]);
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
      expect((await nextBatch(batches)).map((e) => e.row.id)).toEqual([2]);
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
    await nextBatch(batches);
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

  it('should close every open subscription on shutdown', async () => {
    await createTable('shutdown');
    await sql(`INSERT INTO shutdown (id) VALUES (1)`);
    const first = subscribe(tradesTable('shutdown'));
    const second = subscribe(tradesTable('shutdown'));
    await nextBatch(first);
    await nextBatch(second);
    expect(await subscriptions()).toBe(2);

    await streams.onModuleDestroy();
    expect(await waitForSubscriptions(0)).toBe(0);
    expect((await first.next()).done).toBe(true);
  });

  it('should reject an invalid filter before opening a connection', () => {
    expect(() =>
      subscribe(tradesTable('anything'), { no_such_field: { _eq: 1 } }),
    ).toThrow();
  });

  it('should fail only the subscription whose view is missing', async () => {
    await createTable('healthy');
    await sql(`INSERT INTO healthy (id) VALUES (1)`);
    const missing = subscribe(tradesTable('no_such_view'));
    const healthy = subscribe(tradesTable('healthy'));
    try {
      await expect(missing.next()).rejects.toThrow(/unknown catalog item/);
      expect((await nextBatch(healthy)).map((r) => r.row.id)).toEqual([1]);
    } finally {
      await missing.return();
      await healthy.return();
    }
  });
});
