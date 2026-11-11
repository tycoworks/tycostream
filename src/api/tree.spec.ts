import { toRows, toUpdates } from './tree.js';
import { PostgresType, RowUpdateType } from '../common/types.js';
import type { Row, RowUpdateEvent } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { addForeignKey } from '../config/sources.config.js';

// Instruments, their positions, and the positions' trades, each related to
// the next by a foreign key
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
addForeignKey(positions, 'instrument_id', instruments);
addForeignKey(trades, 'instrument_id', positions);

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
    fields: string[],
    row: Row = trade,
  ): RowUpdateEvent => ({
    type,
    path: [],
    keys: [8],
    fields: new Set(fields),
    row,
  });
  const position = { instrument_id: 1, symbol: 'AAPL', net_position: 600 };

  it("should send an insert's related row whole, as one field", () => {
    expect(
      toUpdates([change(RowUpdateType.Insert, Object.keys(trade))]),
    ).toEqual([
      {
        operation: RowUpdateType.Insert,
        fields: ['id', 'quantity', 'positions'],
        data: { id: 8, quantity: 100, positions: position },
      },
    ]);
  });

  it('should name a related row in an update when any of its columns changed, and send it whole', () => {
    expect(
      toUpdates([
        change(RowUpdateType.Update, ['id', 'positions.net_position'], {
          ...trade,
          'positions.net_position': 700,
        }),
      ]),
    ).toEqual([
      {
        operation: RowUpdateType.Update,
        fields: ['id', 'positions'],
        data: { id: 8, positions: { ...position, net_position: 700 } },
      },
    ]);
  });

  it('should send a related row that no longer matches as null', () => {
    expect(
      toUpdates([
        change(
          RowUpdateType.Update,
          [
            'id',
            'positions.instrument_id',
            'positions.symbol',
            'positions.net_position',
          ],
          {
            ...trade,
            'positions.instrument_id': null,
            'positions.symbol': null,
            'positions.net_position': null,
          },
        ),
      ]),
    ).toEqual([
      {
        operation: RowUpdateType.Update,
        fields: ['id', 'positions'],
        data: { id: 8, positions: null },
      },
    ]);
  });

  it("should leave a related row out of an update that didn't change it, and out of a delete", () => {
    expect(
      toUpdates([
        change(RowUpdateType.Update, ['id', 'quantity']),
        change(RowUpdateType.Delete, ['id']),
      ]),
    ).toEqual([
      {
        operation: RowUpdateType.Update,
        fields: ['id', 'quantity'],
        data: { id: 8, quantity: 100 },
      },
      { operation: RowUpdateType.Delete, fields: ['id'], data: { id: 8 } },
    ]);
  });
});
