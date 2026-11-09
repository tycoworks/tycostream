import type pg from 'pg';
import { insertOf, parseRow, readSnapshot } from './postgres.js';
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

  it('should yield the rows, typed, as one batch of inserts with no timestamp, then end', async () => {
    const { client } = clientReturning([
      { id: '1', name: 'a' },
      { id: '2', name: null },
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

const source = (fields: SourceDefinition['fields']): SourceDefinition => ({
  name: 'test',
  primaryKeyField: fields[0].name,
  fields,
});

describe('parseRow', () => {
  const typed = (fields: SourceDefinition['fields'], row: RawRow) =>
    parseRow(source(fields), row);

  it('should parse booleans', () => {
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Text },
          { name: 'yes', type: PostgresType.Bool },
          { name: 'no', type: PostgresType.Bool },
        ],
        { id: '1', yes: 't', no: 'f' },
      ),
    ).toEqual({ id: '1', yes: true, no: false });
  });

  it('should parse integers and floats, including scientific notation', () => {
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Int4 },
          { name: 'small', type: PostgresType.Int2 },
          { name: 'price', type: PostgresType.Float8 },
          { name: 'rate', type: PostgresType.Float4 },
        ],
        { id: '42', small: '-7', price: '99.99', rate: '-4.56e-3' },
      ),
    ).toEqual({ id: 42, small: -7, price: 99.99, rate: -4.56e-3 });
  });

  it('should keep bigints and numerics as strings to preserve precision', () => {
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Text },
          { name: 'big', type: PostgresType.Int8 },
          { name: 'amount', type: PostgresType.Numeric },
        ],
        {
          id: '1',
          big: '9223372036854775807',
          amount: '12345678901234567890.123',
        },
      ),
    ).toEqual({
      id: '1',
      big: '9223372036854775807',
      amount: '12345678901234567890.123',
    });
  });

  it('should keep timestamps, dates, times, UUIDs and JSON as strings', () => {
    const row = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      at: '2023-01-15 14:30:00',
      atZone: '2023-01-15 14:30:00+00',
      day: '1990-05-20',
      time: '09:15:30',
      meta: '{"key":"value","num":42}',
    };
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Uuid },
          { name: 'at', type: PostgresType.Timestamp },
          { name: 'atZone', type: PostgresType.Timestamptz },
          { name: 'day', type: PostgresType.Date },
          { name: 'time', type: PostgresType.Time },
          { name: 'meta', type: PostgresType.Jsonb },
        ],
        row,
      ),
    ).toEqual(row);
  });

  it('should keep nulls as nulls whatever the type', () => {
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Int4 },
          { name: 'flag', type: PostgresType.Bool },
          { name: 'qty', type: PostgresType.Float8 },
          { name: 'name', type: PostgresType.Text },
        ],
        { id: '1', flag: null, qty: null, name: null },
      ),
    ).toEqual({ id: 1, flag: null, qty: null, name: null });
  });

  it('should give NaN for numbers that do not parse', () => {
    const row = typed(
      [
        { name: 'id', type: PostgresType.Text },
        { name: 'int', type: PostgresType.Int4 },
        { name: 'float', type: PostgresType.Float8 },
      ],
      { id: '1', int: 'not_a_number', float: 'invalid' },
    );
    expect(row.int).toBeNaN();
    expect(row.float).toBeNaN();
  });

  it('should keep enum values as their strings', () => {
    const status: EnumType = {
      name: 'order_status',
      values: ['pending', 'shipped', 'delivered'],
    };
    expect(
      typed(
        [
          { name: 'id', type: PostgresType.Int4 },
          { name: 'status', type: PostgresType.Text, enumType: status },
          { name: 'other', type: PostgresType.Text, enumType: status },
        ],
        { id: '1', status: 'shipped', other: null },
      ),
    ).toEqual({ id: 1, status: 'shipped', other: null });
  });

  it('should take only the schema columns', () => {
    expect(
      Object.keys(
        typed([{ name: 'id', type: PostgresType.Int4 }], {
          id: '1',
          mz_timestamp: '42',
        }),
      ),
    ).toEqual(['id']);
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
