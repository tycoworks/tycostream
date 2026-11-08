import type pg from 'pg';
import {
  KeyViolationError,
  MaterializeSubscriptionProtocol,
  pairChanges,
  ProgressBatcher,
} from './materialize.js';
import type { DiffRow } from './materialize.js';
import type { RawRow } from './rows.js';
import { RowUpdateType } from '../common/types.js';
import type { Row } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';

const source = (fields: SourceDefinition['fields']): SourceDefinition => ({
  name: 'test',
  primaryKeyField: fields[0].name,
  fields,
});

// The columns SUBSCRIBE adds to each row, then the row's own
const change = (
  timestamp: number,
  diff: number,
  row: Record<string, string | null>,
): RawRow => ({
  mz_timestamp: String(timestamp),
  mz_progressed: 'f',
  mz_diff: String(diff),
  ...row,
});
const progress = (timestamp: number): RawRow => ({
  mz_timestamp: String(timestamp),
  mz_progressed: 't',
  mz_diff: null,
});

describe('MaterializeSubscriptionProtocol', () => {
  const idAndName = source([
    { name: 'id', dataType: DataType.Integer },
    { name: 'name', dataType: DataType.String },
  ]);

  // A connection whose FETCHes return the given rows, one list per FETCH,
  // then wait forever, as an idle subscription does
  const fakeClient = (fetches: RawRow[][]) => {
    const queries: unknown[][] = [];
    const client = {
      query: vi.fn((...args: unknown[]) => {
        queries.push(args);
        if ((args[0] as string).startsWith('FETCH')) {
          const rows = fetches.shift();
          return rows ? Promise.resolve({ rows }) : new Promise(() => {});
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    return { client: client as unknown as pg.ClientBase, queries };
  };

  const protocol = new MaterializeSubscriptionProtocol();
  const readAll = (client: pg.ClientBase) =>
    protocol.read(client, idAndName, { sql: 'select 1', parameters: [] });

  describe('read', () => {
    it('should turn off the idle timeout, then declare a cursor for the query inside a transaction, keeping its parameters', async () => {
      const { client, queries } = fakeClient([[progress(1)]]);
      const batches = protocol.read(client, idAndName, {
        sql: 'select "id" from "test" where "id" = $1',
        parameters: [7],
      });
      void batches.next();
      await vi.waitFor(() => expect(queries.length).toBeGreaterThan(3));

      expect(queries[0]).toEqual([
        'SET idle_in_transaction_session_timeout = 0',
      ]);
      expect(queries[1]).toEqual(['BEGIN']);
      expect(queries[2]).toEqual([
        'DECLARE c CURSOR FOR SUBSCRIBE (select "id" from "test" where "id" = $1) WITH (SNAPSHOT, PROGRESS)',
        [7],
      ]);
      expect(queries[3]).toEqual(['FETCH 1000 c']);
    });

    it('should yield each complete timestamp across fetches as row events', async () => {
      const { client } = fakeClient([
        [change(1, 1, { id: '1', name: 'a' })],
        [change(1, 1, { id: '2', name: 'b' }), progress(2)],
        [
          change(2, -1, { id: '1', name: 'a' }),
          change(2, 1, { id: '1', name: 'c' }),
          change(2, -1, { id: '2', name: 'b' }),
          progress(3),
        ],
      ]);
      const batches = readAll(client);

      expect((await batches.next()).value).toEqual([
        {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name']),
          row: { id: 1, name: 'a' },
        },
        {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name']),
          row: { id: 2, name: 'b' },
        },
      ]);
      expect((await batches.next()).value).toEqual([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'name']),
          row: { id: 1, name: 'c' },
        },
        {
          type: RowUpdateType.Delete,
          fields: new Set(['id']),
          row: { id: 2, name: 'b' },
        },
      ]);
    });

    it('should keep two subscriptions on the one protocol apart, each with its own source and rows', async () => {
      const prices = source([
        { name: 'symbol', dataType: DataType.String },
        { name: 'price', dataType: DataType.Float },
      ]);
      const first = fakeClient([
        [change(1, 1, { id: '1', name: 'a' })],
        [progress(2)],
      ]);
      const second = fakeClient([
        [change(1, 1, { symbol: 'AAPL', price: '1.5' })],
        [progress(2)],
      ]);
      const firstBatches = protocol.read(first.client, idAndName, {
        sql: 'select 1',
        parameters: [],
      });
      const secondBatches = protocol.read(second.client, prices, {
        sql: 'select 2',
        parameters: [],
      });

      // Interleaved, so a batcher shared between them would mix their rows
      const [firstEvents, secondEvents] = await Promise.all([
        firstBatches.next(),
        secondBatches.next(),
      ]);
      expect(firstEvents.value).toEqual([
        {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name']),
          row: { id: 1, name: 'a' },
        },
      ]);
      expect(secondEvents.value).toEqual([
        {
          type: RowUpdateType.Insert,
          fields: new Set(['symbol', 'price']),
          row: { symbol: 'AAPL', price: 1.5 },
        },
      ]);
    });

    it('should skip a timestamp whose changes cancel out', async () => {
      const { client } = fakeClient([
        [
          change(1, 1, { id: '1', name: 'a' }),
          change(1, -1, { id: '1', name: 'a' }),
          progress(2),
        ],
        [change(2, 1, { id: '2', name: 'b' }), progress(3)],
      ]);
      const batches = readAll(client);

      expect((await batches.next()).value).toEqual([
        {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name']),
          row: { id: 2, name: 'b' },
        },
      ]);
    });

    it('should fail when a key is not unique', async () => {
      const { client } = fakeClient([
        [
          change(1, 1, { id: '1', name: 'a' }),
          change(1, 1, { id: '1', name: 'b' }),
          progress(2),
        ],
      ]);
      const batches = readAll(client);

      await expect(batches.next()).rejects.toThrow(KeyViolationError);
    });
  });
});

describe('ProgressBatcher', () => {
  const idAndName = source([
    { name: 'id', dataType: DataType.Integer },
    { name: 'name', dataType: DataType.String },
  ]);
  let batcher: ProgressBatcher;

  beforeEach(() => {
    batcher = new ProgressBatcher(idAndName);
  });

  describe('batching by progress', () => {
    it('should hold rows until a progress row passes their timestamp', () => {
      expect(
        batcher.take([
          change(1, 1, { id: '1', name: 'a' }),
          change(1, 1, { id: '2', name: 'b' }),
        ]),
      ).toEqual([]);
      expect(batcher.take([progress(2)])).toEqual([
        [
          { diff: 1, row: { id: 1, name: 'a' } },
          { diff: 1, row: { id: 2, name: 'b' } },
        ],
      ]);
    });

    it('should not release a timestamp that progress has only reached', () => {
      expect(
        batcher.take([change(2, 1, { id: '1', name: 'a' }), progress(2)]),
      ).toEqual([]);
    });

    it('should release each complete timestamp as its own batch, oldest first', () => {
      expect(
        batcher.take([
          change(3, -1, { id: '1', name: 'a' }),
          change(1, 1, { id: '1', name: 'a' }),
          change(3, 1, { id: '1', name: 'b' }),
          progress(4),
        ]),
      ).toEqual([
        [{ diff: 1, row: { id: 1, name: 'a' } }],
        [
          { diff: -1, row: { id: 1, name: 'a' } },
          { diff: 1, row: { id: 1, name: 'b' } },
        ],
      ]);
    });

    it('should keep a timestamp whole across several fetches', () => {
      batcher.take([change(1, 1, { id: '1', name: 'a' })]);
      batcher.take([change(1, 1, { id: '2', name: 'b' })]);
      expect(batcher.take([progress(2)])).toEqual([
        [
          { diff: 1, row: { id: 1, name: 'a' } },
          { diff: 1, row: { id: 2, name: 'b' } },
        ],
      ]);
    });

    it('should release nothing for progress on an idle view', () => {
      expect(batcher.take([progress(1), progress(2)])).toEqual([]);
    });

    it('should keep the count in diffs above one', () => {
      batcher.take([change(1, 2, { id: '1', name: 'a' })]);
      expect(batcher.take([progress(2)])[0][0].diff).toBe(2);
    });
  });

  it('should type each row as the schema says, keeping only its columns', () => {
    batcher.take([change(1, 1, { id: '7', name: 'a' })]);
    const [[{ row }]] = batcher.take([progress(2)]);
    expect(row).toEqual({ id: 7, name: 'a' });
  });
});

describe('pairChanges', () => {
  const FIELDS = ['id', 'symbol', 'qty', 'traded_at'];

  const row = (id: number, symbol: string, qty: number | null, at = 'T1') => ({
    id,
    symbol,
    qty,
    traded_at: at,
  });
  const add = (r: Row): DiffRow => ({ diff: 1, row: r });
  const remove = (r: Row): DiffRow => ({
    diff: -1,
    row: r,
  });

  const pair = (rows: DiffRow[]) => pairChanges(rows, 'id', FIELDS);

  describe('one row per key', () => {
    it('should make a lone +1 an insert with every field', () => {
      expect(pair([add(row(1, 'AAPL', 10))])).toEqual([
        {
          type: RowUpdateType.Insert,
          fields: new Set(FIELDS),
          row: row(1, 'AAPL', 10),
        },
      ]);
    });

    it('should make a lone -1 a delete of the key', () => {
      expect(pair([remove(row(1, 'AAPL', 10))])).toEqual([
        {
          type: RowUpdateType.Delete,
          fields: new Set(['id']),
          row: row(1, 'AAPL', 10),
        },
      ]);
    });
  });

  describe('updates', () => {
    it('should pair a -1 and a +1 into an update of the changed fields', () => {
      expect(
        pair([remove(row(1, 'AAPL', 10)), add(row(1, 'AAPL', 15, 'T2'))]),
      ).toEqual([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'qty', 'traded_at']),
          row: row(1, 'AAPL', 15, 'T2'),
        },
      ]);
    });

    it('should pair them whichever arrives first', () => {
      expect(
        pair([add(row(1, 'AAPL', 15)), remove(row(1, 'AAPL', 10))]),
      ).toEqual([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'qty']),
          row: row(1, 'AAPL', 15),
        },
      ]);
    });

    it('should count a field changing to or from null as a change', () => {
      expect(
        pair([remove(row(1, 'AAPL', 10)), add(row(1, 'AAPL', null))]),
      ).toEqual([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'qty']),
          row: row(1, 'AAPL', null),
        },
      ]);
      expect(
        pair([remove(row(1, 'AAPL', null)), add(row(1, 'AAPL', 0))])[0].fields,
      ).toEqual(new Set(['id', 'qty']));
    });

    it('should compare dates by instant and bigints by value', () => {
      const at = (iso: string) => new Date(iso);
      const before = {
        id: 1,
        symbol: 'AAPL',
        qty: 10n,
        traded_at: at('2026-01-01T00:00:00Z'),
      };
      const same = {
        id: 1,
        symbol: 'MSFT',
        qty: 10n,
        traded_at: at('2026-01-01T00:00:00Z'),
      };
      expect(pair([remove(before), add(same)])[0].fields).toEqual(
        new Set(['id', 'symbol']),
      );
      const later = {
        ...before,
        qty: 11n,
        traded_at: at('2026-01-02T00:00:00Z'),
      };
      expect(pair([remove(before), add(later)])[0].fields).toEqual(
        new Set(['id', 'qty', 'traded_at']),
      );
    });
  });

  describe('netting', () => {
    it('should drop identical rows that cancel out', () => {
      expect(
        pair([add(row(1, 'AAPL', 10)), remove(row(1, 'AAPL', 10))]),
      ).toEqual([]);
    });

    it('should net before pairing, so a change that is undone within the timestamp is no change', () => {
      expect(
        pair([
          remove(row(1, 'AAPL', 10)),
          add(row(1, 'AAPL', 15)),
          remove(row(1, 'AAPL', 15)),
          add(row(1, 'AAPL', 10)),
        ]),
      ).toEqual([]);
    });

    it('should not net rows that differ only by null and the text "null"', () => {
      const nullSymbol = { id: 1, symbol: null, qty: 1, traded_at: 'T1' };
      const textNull = { id: 1, symbol: 'null', qty: 1, traded_at: 'T1' };
      expect(pair([remove(nullSymbol), add(textNull)])[0].type).toBe(
        RowUpdateType.Update,
      );
    });
  });

  describe('several keys in one timestamp', () => {
    it('should give each key its own event', () => {
      const events = pair([
        add(row(3, 'MSFT', 5)),
        remove(row(1, 'AAPL', 10)),
        add(row(1, 'AAPL', 15)),
        remove(row(2, 'GOOG', 7)),
      ]);
      expect(events).toHaveLength(3);
      expect(events.map((e) => [e.row.id, e.type])).toEqual([
        [3, RowUpdateType.Insert],
        [1, RowUpdateType.Update],
        [2, RowUpdateType.Delete],
      ]);
    });

    it('should make a snapshot, all +1, into inserts', () => {
      const snapshot = [1, 2, 3].map((id) => add(row(id, 'AAPL', id)));
      expect(pair(snapshot).map((e) => e.type)).toEqual([
        RowUpdateType.Insert,
        RowUpdateType.Insert,
        RowUpdateType.Insert,
      ]);
    });
  });

  describe('rows entering and leaving a filter', () => {
    it('should make a row entering the filter an insert, and one leaving it a delete', () => {
      // A filtered SUBSCRIBE sends only the side of a change that matches
      expect(pair([add(row(1, 'AAPL', 15))])[0].type).toBe(
        RowUpdateType.Insert,
      );
      expect(pair([remove(row(1, 'AAPL', 10))])[0].type).toBe(
        RowUpdateType.Delete,
      );
    });
  });

  describe('key violations', () => {
    it('should reject two +1 rows for one key', () => {
      expect(() =>
        pair([add(row(1, 'AAPL', 10)), add(row(1, 'MSFT', 10))]),
      ).toThrow(KeyViolationError);
    });

    it('should reject a diff of +2', () => {
      expect(() => pair([{ diff: 2, row: row(1, 'AAPL', 10) }])).toThrow(
        "More than one row for id = 1: the key isn't unique",
      );
    });

    it('should reject two -1 rows for one key', () => {
      expect(() =>
        pair([remove(row(1, 'AAPL', 10)), remove(row(1, 'MSFT', 10))]),
      ).toThrow(KeyViolationError);
    });
  });
});
