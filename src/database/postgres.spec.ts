import type pg from 'pg';
import {
  KeyViolationError,
  insertOf,
  isoTimestamp,
  readSnapshot,
  TYPE_PARSERS,
} from './postgres.js';
import type { RawRow } from './postgres.js';
import { Statement } from './statement.js';
import { RowUpdateType, PostgresType, StreamMode } from '../common/types.js';
import type { RowUpdateBatch } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { addForeignKey } from '../config/sources.config.js';

// A row's plain values, as the tests write them
type Values = Record<string, string | number | boolean | null>;

// A selected row as the statement gives it: its source's number, and one
// JSON object of its columns' values, as the text the database writes for them
const packed = (row: Values): RawRow => ({
  __source: 0,
  __keys: [String(Object.values(row)[0])],
  __row: Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      column,
      value === null ? null : String(value),
    ]),
  ),
});

describe('readSnapshot', () => {
  const clientReturning = (rows: RawRow[]) => {
    const query = vi.fn(() => Promise.resolve({ rows }));
    return { client: { query } as unknown as pg.ClientBase, query };
  };
  // A query of every test row with id 7
  const statement = new Statement(
    {
      name: 'test',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: PostgresType.Int4 },
        { name: 'name', type: PostgresType.Text },
      ],
    },
    { where: { id: { _eq: 7 } } },
    StreamMode.Snapshot,
  );
  const readAll = async (client: pg.ClientBase, read = statement) => {
    const batches: RowUpdateBatch[] = [];
    for await (const batch of readSnapshot(client, read)) {
      batches.push(batch);
    }
    return batches;
  };

  it('should run the SELECT with its parameters', async () => {
    const { client, query } = clientReturning([]);

    await readAll(client);

    expect(query).toHaveBeenCalledWith(statement.sql, [7]);
  });

  it('should yield the rows as one batch of inserts with no timestamp, then end', async () => {
    const { client } = clientReturning([
      packed({ id: 1, name: 'a', extra: 'dropped' }),
      packed({ id: 2, name: null }),
    ]);

    expect(await readAll(client)).toEqual([
      {
        events: [
          {
            type: RowUpdateType.Insert,
            path: [],
            keys: [1],
            fields: new Set(['id', 'name']),
            row: { id: 1, name: 'a' },
          },
          {
            type: RowUpdateType.Insert,
            path: [],
            keys: [2],
            fields: new Set(['id', 'name']),
            row: { id: 2, name: null },
          },
        ],
      },
    ]);
  });

  it('should yield the snapshot even for an empty source, as a live stream does', async () => {
    const { client } = clientReturning([]);

    expect(await readAll(client)).toEqual([{ events: [] }]);
  });

  it("should fail when two rows have one key, as the source's key isn't unique, as a live stream does", async () => {
    const { client } = clientReturning([
      packed({ id: 1, name: 'a' }),
      packed({ id: 1, name: 'b' }),
    ]);

    await expect(readAll(client)).rejects.toThrow(KeyViolationError);
  });

  describe("a related source's rows, by their path and keys", () => {
    // Positions, each with its trades and its orders
    const positions: SourceDefinition = {
      name: 'positions',
      primaryKeyField: 'id',
      fields: [{ name: 'id', type: PostgresType.Int4 }],
      relationships: new Map(),
    };
    for (const name of ['trades', 'orders']) {
      const related: SourceDefinition = {
        name,
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: PostgresType.Int4 },
          { name: 'position_id', type: PostgresType.Int4 },
        ],
        relationships: new Map(),
      };
      addForeignKey(related, 'position_id', positions);
    }
    const withLists = new Statement(
      positions,
      { relationships: { trades: {}, orders: {} } },
      StreamMode.Snapshot,
    );
    // Row 5 of a related source, under a position: a trade's is source 1, an
    // order's source 2
    const fifth = (source: number, position = '1'): RawRow => ({
      __source: source,
      __keys: [position, '5'],
      __row: { id: '5', position_id: position },
    });

    it("should keep two related sources' rows apart, though their keys match: trade 5's and order 5's", async () => {
      const { client } = clientReturning([fifth(1), fifth(2)]);

      const [{ events }] = await readAll(client, withLists);

      expect(events.map(({ path, keys }) => [path, keys])).toEqual([
        [['trades'], [1, 5]],
        [['orders'], [1, 5]],
      ]);
    });

    it('should keep one row under two parents apart: trade 5 under positions 1 and 2', async () => {
      const { client } = clientReturning([fifth(1, '1'), fifth(1, '2')]);

      const [{ events }] = await readAll(client, withLists);

      expect(events.map(({ keys }) => keys)).toEqual([
        [1, 5],
        [2, 5],
      ]);
    });

    it("should fail when a related source has a row twice for one parent, naming the row's key by its path", async () => {
      const { client } = clientReturning([fifth(1), fifth(1)]);

      await expect(readAll(client, withLists)).rejects.toThrow(
        "More than one row for trades.id with keys [1,5]: its key, a parent's or a related row's isn't unique",
      );
    });
  });
});

describe('TYPE_PARSERS', () => {
  // A value's text, as the database sends it, through the parser for its type
  const parse = (type: PostgresType, text: string) =>
    TYPE_PARSERS.getTypeParser(type)(text);

  it("should keep node-postgres's conversions where they suit: numbers, booleans and JSON", () => {
    expect(parse(PostgresType.Int2, '-7')).toBe(-7);
    expect(parse(PostgresType.Int4, '42')).toBe(42);
    expect(parse(PostgresType.Float4, '-4.56e-3')).toBe(-4.56e-3);
    expect(parse(PostgresType.Float8, '2.25')).toBe(2.25);
    expect(parse(PostgresType.Bool, 't')).toBe(true);
    expect(parse(PostgresType.Bool, 'f')).toBe(false);
    expect(parse(PostgresType.Jsonb, '{"a":1,"b":[true]}')).toEqual({
      a: 1,
      b: [true],
    });
    expect(parse(PostgresType.Json, '[1,2]')).toEqual([1, 2]);
    expect(parse(PostgresType.Text, 'x')).toBe('x');
    expect(
      parse(PostgresType.Uuid, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'),
    ).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(parse(PostgresType.Time, '16:00:01')).toBe('16:00:01');
  });

  it('should make int8 and numeric numbers, as Hasura sends them by default, which keep about 15 significant digits', () => {
    expect(parse(PostgresType.Int8, '9007199254740991')).toBe(9007199254740991);
    expect(parse(PostgresType.Numeric, '1234.5678')).toBe(1234.5678);
    // Beyond what a number holds, the last digits are lost
    expect(parse(PostgresType.Int8, '9007199254740993')).toBe(9007199254740992);
  });

  it('should send timestamps in ISO 8601, as Postgres writes them in JSON, rather than as Dates', () => {
    expect(parse(PostgresType.Timestamp, '2026-01-01 09:30:00.5')).toBe(
      '2026-01-01T09:30:00.5',
    );
    expect(parse(PostgresType.Timestamptz, '2026-01-01 07:30:00+00')).toBe(
      '2026-01-01T07:30:00+00:00',
    );
  });

  it('should keep dates, intervals and bytea as text, rather than a Date, an object and a Buffer', () => {
    expect(parse(PostgresType.Date, '2026-01-02')).toBe('2026-01-02');
    expect(parse(PostgresType.Interval, '1 day 02:00:00')).toBe(
      '1 day 02:00:00',
    );
    expect(parse(PostgresType.Bytea, '\\x0102')).toBe('\\x0102');
  });
});

describe('isoTimestamp', () => {
  it('should join the date and time with a T, and write an offset of whole hours with its minutes', () => {
    expect(isoTimestamp('2026-01-01 09:30:00')).toBe('2026-01-01T09:30:00');
    expect(isoTimestamp('2026-01-01 07:30:00.123456-05')).toBe(
      '2026-01-01T07:30:00.123456-05:00',
    );
    expect(isoTimestamp('2026-01-01 07:30:00+05:30')).toBe(
      '2026-01-01T07:30:00+05:30',
    );
  });

  it('should leave infinity as Postgres writes it', () => {
    expect(isoTimestamp('infinity')).toBe('infinity');
  });
});

describe('insertOf', () => {
  it('should make a row an insert of every column', () => {
    expect(
      insertOf({
        path: [],
        keys: [1],
        keyField: 'id',
        row: { id: 1, name: 'a' },
      }),
    ).toEqual({
      type: RowUpdateType.Insert,
      path: [],
      keys: [1],
      fields: new Set(['id', 'name']),
      row: { id: 1, name: 'a' },
    });
  });
});
