import { toRows, toUpdates } from './tree.js';
import { PostgresType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateEvent } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { addForeignKey } from '../config/sources.config.js';

// Instruments, their positions, and the positions' trades and orders, each
// related to the next by a foreign key
const instruments: SourceDefinition = {
  name: 'instruments',
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
  relationships: new Map(),
};
const positions: SourceDefinition = {
  name: 'positions',
  primaryKeyField: 'instrument_id',
  fields: [{ name: 'instrument_id', type: PostgresType.Int4 }],
  relationships: new Map(),
};
const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
  relationships: new Map(),
};
const orders: SourceDefinition = {
  name: 'orders',
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
  relationships: new Map(),
};
addForeignKey(positions, 'instrument_id', instruments);
addForeignKey(trades, 'instrument_id', positions);
addForeignKey(orders, 'instrument_id', positions);

// A query's change: an insert of the row at its path and keys
const insert = (path: string[], keys: unknown[], row: Row): RowUpdateEvent => ({
  type: RowUpdateType.Insert,
  path,
  keys,
  fields: new Set(Object.keys(row)),
  row,
});

describe('toRows', () => {
  it('should give the selected rows in the order they came', () => {
    expect(
      toRows(positions, [
        insert([], [2], { instrument_id: 2, symbol: 'MSFT' }),
        insert([], [1], { instrument_id: 1, symbol: 'AAPL' }),
      ]),
    ).toEqual([
      { instrument_id: 2, symbol: 'MSFT' },
      { instrument_id: 1, symbol: 'AAPL' },
    ]);
  });

  describe('related rows', () => {
    it("should fold a related row's columns into an object under its field: a trade's position", () => {
      expect(
        toRows(trades, [
          insert([], [8], {
            id: 8,
            quantity: 100,
            'positions.instrument_id': 1,
            'positions.symbol': 'AAPL',
          }),
        ]),
      ).toEqual([
        {
          id: 8,
          quantity: 100,
          positions: { instrument_id: 1, symbol: 'AAPL' },
        },
      ]);
    });

    it('should make a related row that matched nothing null: a trade with no position', () => {
      expect(
        toRows(trades, [
          insert([], [9], {
            id: 9,
            'positions.instrument_id': null,
            'positions.symbol': null,
          }),
        ]),
      ).toEqual([{ id: 9, positions: null }]);
    });

    it("should fold a related row's own related rows, each null on its own: a trade's position's instrument", () => {
      expect(
        toRows(trades, [
          insert([], [8], {
            id: 8,
            'positions.instrument_id': 1,
            'positions.instruments.id': 1,
            'positions.instruments.name': 'Apple Inc.',
          }),
          insert([], [9], {
            id: 9,
            'positions.instrument_id': 2,
            'positions.instruments.id': null,
            'positions.instruments.name': null,
          }),
        ]),
      ).toEqual([
        {
          id: 8,
          positions: {
            instrument_id: 1,
            instruments: { id: 1, name: 'Apple Inc.' },
          },
        },
        { id: 9, positions: { instrument_id: 2, instruments: null } },
      ]);
    });
  });

  describe('lists', () => {
    it("should put each list's rows under their parent, in the order they came, whether the parent comes before them or after", () => {
      expect(
        toRows(positions, [
          insert(['trades'], [2, 9], { id: 9 }),
          insert([], [1], { instrument_id: 1, symbol: 'AAPL' }),
          insert(['trades'], [1, 8], { id: 8 }),
          insert([], [2], { instrument_id: 2, symbol: 'MSFT' }),
          insert(['trades'], [1, 7], { id: 7 }),
        ]),
      ).toEqual([
        { instrument_id: 1, symbol: 'AAPL', trades: [{ id: 8 }, { id: 7 }] },
        { instrument_id: 2, symbol: 'MSFT', trades: [{ id: 9 }] },
      ]);
    });

    it('should leave out a list with no rows', () => {
      expect(
        toRows(positions, [insert([], [3], { instrument_id: 3 })]),
      ).toEqual([{ instrument_id: 3 }]);
    });

    it("should put a list's rows within a list under their parent: an instrument's positions' trades", () => {
      expect(
        toRows(instruments, [
          insert([], [1], { id: 1 }),
          insert(['positions'], [1, 1], { instrument_id: 1 }),
          insert(['positions', 'trades'], [1, 1, 8], { id: 8 }),
        ]),
      ).toEqual([
        { id: 1, positions: [{ instrument_id: 1, trades: [{ id: 8 }] }] },
      ]);
    });

    it("should put a list under a related row in that row, as the related row adds no key: a trade's position's trades", () => {
      expect(
        toRows(trades, [
          insert([], [7], {
            id: 7,
            'positions.instrument_id': 1,
            'positions.symbol': 'AAPL',
          }),
          insert(['positions', 'trades'], [7, 8], { id: 8 }),
          insert(['positions', 'trades'], [7, 7], { id: 7 }),
        ]),
      ).toEqual([
        {
          id: 7,
          positions: {
            instrument_id: 1,
            symbol: 'AAPL',
            trades: [{ id: 8 }, { id: 7 }],
          },
        },
      ]);
    });
  });
});

describe('toUpdates', () => {
  // Trade 8, with its position
  const trade = {
    id: 8,
    quantity: 100,
    'positions.instrument_id': 1,
    'positions.symbol': 'AAPL',
    'positions.net_position': 600,
  };
  const change = (
    type: RowUpdateType,
    row: Row = trade,
    keys: unknown[] = [8],
  ): RowUpdateEvent => ({
    type,
    path: [],
    keys,
    fields: new Set(Object.keys(row)),
    row,
  });
  const position = { instrument_id: 1, symbol: 'AAPL', net_position: 600 };

  it("should send an insert's whole row, its related row folded in as one field", () => {
    expect(toUpdates(trades, [change(RowUpdateType.Insert)])).toEqual([
      {
        operation: RowUpdateType.Insert,
        key: 8,
        data: { id: 8, quantity: 100, positions: position },
      },
    ]);
  });

  it("should send an update's whole row, the columns that didn't change too, its related row folded in", () => {
    // Only the position's net_position changed
    const event: RowUpdateEvent = {
      ...change(RowUpdateType.Update, {
        ...trade,
        'positions.net_position': 700,
      }),
      fields: new Set(['id', 'positions.net_position']),
    };

    expect(toUpdates(trades, [event])).toEqual([
      {
        operation: RowUpdateType.Update,
        key: 8,
        data: {
          id: 8,
          quantity: 100,
          positions: { ...position, net_position: 700 },
        },
      },
    ]);
  });

  it('should send a related row that no longer matches as null, in the whole row', () => {
    expect(
      toUpdates(trades, [
        change(RowUpdateType.Update, {
          ...trade,
          'positions.instrument_id': null,
          'positions.symbol': null,
          'positions.net_position': null,
        }),
      ]),
    ).toEqual([
      {
        operation: RowUpdateType.Update,
        key: 8,
        data: { id: 8, quantity: 100, positions: null },
      },
    ]);
  });

  it("should send an unchanged related row whole in an update that changed only the row's own columns", () => {
    // Only quantity changed, and the position didn't
    const event: RowUpdateEvent = {
      ...change(RowUpdateType.Update, { ...trade, quantity: 150 }),
      fields: new Set(['id', 'quantity']),
    };

    expect(toUpdates(trades, [event])).toEqual([
      {
        operation: RowUpdateType.Update,
        key: 8,
        data: { id: 8, quantity: 150, positions: position },
      },
    ]);
  });

  it('should send a related row that matched nothing as null in an insert', () => {
    expect(
      toUpdates(trades, [
        change(
          RowUpdateType.Insert,
          {
            id: 10,
            quantity: 50,
            'positions.instrument_id': null,
            'positions.symbol': null,
            'positions.net_position': null,
          },
          [10],
        ),
      ]),
    ).toEqual([
      {
        operation: RowUpdateType.Insert,
        key: 10,
        data: { id: 10, quantity: 50, positions: null },
      },
    ]);
  });

  it('should send a delete with its key and no row', () => {
    expect(
      toUpdates(trades, [change(RowUpdateType.Delete, { id: 8 })]),
    ).toEqual([{ operation: RowUpdateType.Delete, key: 8, data: null }]);
  });

  it("should send a key of 0, and a text key, as the update's key unchanged", () => {
    expect(
      toUpdates(trades, [
        change(RowUpdateType.Insert, { id: 0, quantity: 5 }, [0]),
        change(RowUpdateType.Update, { id: 'AB-1', quantity: 5 }, ['AB-1']),
        change(RowUpdateType.Delete, { id: '' }, ['']),
      ]).map(({ operation, key }) => [operation, key]),
    ).toEqual([
      [RowUpdateType.Insert, 0],
      [RowUpdateType.Update, 'AB-1'],
      [RowUpdateType.Delete, ''],
    ]);
  });

  describe('lists', () => {
    // A change at a path and keys
    const at = (
      type: RowUpdateType,
      path: string[],
      keys: unknown[],
      row: Row,
    ): RowUpdateEvent => ({
      type,
      path,
      keys,
      fields: new Set(Object.keys(row)),
      row,
    });
    const update = (
      operation: RowUpdateType,
      key: unknown,
      data: Row | null,
      lists?: Record<string, unknown[]>,
    ) => ({ operation, key, data, ...(lists && { lists }) });

    it("should put each list's updates under their parent's, whether the parent comes before them or after: the snapshot as a tree", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Insert, ['trades'], [1, 8], { id: 8 }),
          at(RowUpdateType.Insert, [], [1], { instrument_id: 1 }),
          at(RowUpdateType.Insert, ['trades'], [1, 7], { id: 7 }),
        ]),
      ).toEqual([
        update(
          RowUpdateType.Insert,
          1,
          { instrument_id: 1 },
          {
            trades: [
              update(RowUpdateType.Insert, 8, { id: 8 }),
              update(RowUpdateType.Insert, 7, { id: 7 }),
            ],
          },
        ),
      ]);
    });

    it("should put a new trade, and the one it pushes out, under the position's own update", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Update, [], [1], {
            instrument_id: 1,
            net_position: 700,
          }),
          at(RowUpdateType.Insert, ['trades'], [1, 9], { id: 9 }),
          at(RowUpdateType.Delete, ['trades'], [1, 7], { id: 7 }),
        ]),
      ).toEqual([
        update(
          RowUpdateType.Update,
          1,
          { instrument_id: 1, net_position: 700 },
          {
            trades: [
              update(RowUpdateType.Insert, 9, { id: 9 }),
              update(RowUpdateType.Delete, 7, null),
            ],
          },
        ),
      ]);
    });

    it('should give a parent whose rows changed, but not itself, an UPDATE of its key and no row: a trade corrected', () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Update, ['trades'], [1, 8], { id: 8, price: 201 }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 1, null, {
          trades: [update(RowUpdateType.Update, 8, { id: 8, price: 201 })],
        }),
      ]);
    });

    it("should put a parent's DELETE's rows' DELETEs under it: a position closed", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Delete, ['trades'], [2, 9], { id: 9 }),
          at(RowUpdateType.Delete, [], [2], { instrument_id: 2 }),
        ]),
      ).toEqual([
        update(RowUpdateType.Delete, 2, null, {
          trades: [update(RowUpdateType.Delete, 9, null)],
        }),
      ]);
    });

    it('should put a row moved between parents under each: a DELETE under one, an INSERT under the other', () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Delete, ['trades'], [2, 9], { id: 9 }),
          at(RowUpdateType.Insert, ['trades'], [1, 9], { id: 9 }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 2, null, {
          trades: [update(RowUpdateType.Delete, 9, null)],
        }),
        update(RowUpdateType.Update, 1, null, {
          trades: [update(RowUpdateType.Insert, 9, { id: 9 })],
        }),
      ]);
    });

    it("should put two lists' updates under one UPDATE of their parent's key: a trade filled and an order cancelled", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Insert, ['trades'], [1, 9], { id: 9 }),
          at(RowUpdateType.Delete, ['orders'], [1, 4], { id: 4 }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 1, null, {
          trades: [update(RowUpdateType.Insert, 9, { id: 9 })],
          orders: [update(RowUpdateType.Delete, 4, null)],
        }),
      ]);
    });

    it("should give each level above a change an UPDATE of its key and no row, two levels deep: a trade under an instrument's position", () => {
      expect(
        toUpdates(instruments, [
          at(RowUpdateType.Insert, ['positions', 'trades'], [10, 1, 8], {
            id: 8,
          }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 10, null, {
          positions: [
            update(RowUpdateType.Update, 1, null, {
              trades: [update(RowUpdateType.Insert, 8, { id: 8 })],
            }),
          ],
        }),
      ]);
    });

    it("should fold a related row into a list row's data", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Update, ['trades'], [1, 8], {
            id: 8,
            'accounts.id': 3,
            'accounts.name': 'Growth Fund',
          }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 1, null, {
          trades: [
            update(RowUpdateType.Update, 8, {
              id: 8,
              accounts: { id: 3, name: 'Growth Fund' },
            }),
          ],
        }),
      ]);
    });

    it('should give each level above a row moved between parents two levels down an UPDATE with no row: a trade moved between positions', () => {
      expect(
        toUpdates(instruments, [
          at(RowUpdateType.Delete, ['positions', 'trades'], [10, 1, 8], {
            id: 8,
          }),
          at(RowUpdateType.Insert, ['positions', 'trades'], [10, 2, 8], {
            id: 8,
          }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 10, null, {
          positions: [
            update(RowUpdateType.Update, 1, null, {
              trades: [update(RowUpdateType.Delete, 8, null)],
            }),
            update(RowUpdateType.Update, 2, null, {
              trades: [update(RowUpdateType.Insert, 8, { id: 8 })],
            }),
          ],
        }),
      ]);
    });

    it("should send a list's text key, and a key of 0, as they are", () => {
      expect(
        toUpdates(positions, [
          at(RowUpdateType.Insert, ['trades'], ['AAPL', 0], { id: 0 }),
        ]),
      ).toEqual([
        update(RowUpdateType.Update, 'AAPL', null, {
          trades: [update(RowUpdateType.Insert, 0, { id: 0 })],
        }),
      ]);
    });
  });
});
