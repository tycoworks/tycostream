import type pg from 'pg';
import {
  insertOf,
  isoTimestamp,
  pickRow,
  readSnapshot,
  TYPE_PARSERS,
} from './postgres.js';
import type { RawRow } from './postgres.js';
import type { SourceDefinition, EnumType } from '../config/source.types.js';
import { RowUpdateType, PostgresType } from '../common/types.js';
import type { RowUpdateBatch } from '../common/types.js';

const idAndName: SourceDefinition = {
  name: 'test',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'name', type: PostgresType.Text },
  ],
};

describe('readSnapshot', () => {
  const clientReturning = (rows: RawRow[]) => {
    const query = vi.fn(() => Promise.resolve({ rows }));
    return { client: { query } as unknown as pg.ClientBase, query };
  };
  const readAll = async (client: pg.ClientBase) => {
    const batches: RowUpdateBatch[] = [];
    for await (const batch of readSnapshot(client, idAndName, {
      sql: 'select "id" from "test" where "id" = $1',
      parameters: [7],
    })) {
      batches.push(batch);
    }
    return batches;
  };

  it('should run the SELECT with its parameters', async () => {
    const { client, query } = clientReturning([]);

    await readAll(client);

    expect(query).toHaveBeenCalledWith(
      'select "id" from "test" where "id" = $1',
      [7],
    );
  });

  it('should yield the rows as one batch of inserts with no timestamp, then end', async () => {
    const { client } = clientReturning([
      { id: 1, name: 'a', extra: 'dropped' },
      { id: 2, name: null },
    ]);

    expect(await readAll(client)).toEqual([
      {
        events: [
          {
            type: RowUpdateType.Insert,
            fields: new Set(['id', 'name']),
            row: { id: 1, name: 'a' },
          },
          {
            type: RowUpdateType.Insert,
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
});

describe('TYPE_PARSERS', () => {
  // A value's text, as the database sends it, through the parser for its type
  const parse = (type: PostgresType, text: string) =>
    TYPE_PARSERS.getTypeParser(type)(text);

  it("should keep node-postgres's conversions where they suit: numbers, booleans and JSON, with int8 and numeric as strings", () => {
    expect(parse(PostgresType.Int2, '-7')).toBe(-7);
    expect(parse(PostgresType.Int4, '42')).toBe(42);
    expect(parse(PostgresType.Float4, '-4.56e-3')).toBe(-4.56e-3);
    expect(parse(PostgresType.Float8, '2.25')).toBe(2.25);
    expect(parse(PostgresType.Bool, 't')).toBe(true);
    expect(parse(PostgresType.Bool, 'f')).toBe(false);
    expect(parse(PostgresType.Int8, '9223372036854775807')).toBe(
      '9223372036854775807',
    );
    expect(parse(PostgresType.Numeric, '12345678901234567890.123')).toBe(
      '12345678901234567890.123',
    );
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

describe('pickRow', () => {
  it("should keep only the source's columns, as typed, with null for a missing value", () => {
    expect(
      pickRow(idAndName, { id: 7, name: null, mz_timestamp: '42' }),
    ).toEqual({ id: 7, name: null });
  });

  it('should keep enum values as their strings', () => {
    const status: EnumType = {
      name: 'order_status',
      values: ['pending', 'shipped'],
    };
    const orders: SourceDefinition = {
      name: 'orders',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: PostgresType.Int4 },
        { name: 'status', type: PostgresType.Text, enumType: status },
      ],
    };
    expect(pickRow(orders, { id: 1, status: 'shipped' })).toEqual({
      id: 1,
      status: 'shipped',
    });
  });
});

describe('insertOf', () => {
  it('should make a row an insert of every column', () => {
    expect(insertOf({ id: 1, name: 'a' }, ['id', 'name'])).toEqual({
      type: RowUpdateType.Insert,
      fields: new Set(['id', 'name']),
      row: { id: 1, name: 'a' },
    });
  });
});
