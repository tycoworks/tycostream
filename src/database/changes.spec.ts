import { KeyViolationError, pairChanges } from './changes.js';
import type { DiffRow } from './changes.js';
import { RowUpdateType } from '../common/types.js';

const FIELDS = ['id', 'symbol', 'qty', 'traded_at'];

const row = (id: number, symbol: string, qty: number | null, at = 'T1') => ({
  id,
  symbol,
  qty,
  traded_at: at,
});
const add = (r: Record<string, unknown>): DiffRow => ({ diff: 1, row: r });
const remove = (r: Record<string, unknown>): DiffRow => ({ diff: -1, row: r });

const pair = (rows: DiffRow[]) => pairChanges(rows, 'id', FIELDS);

describe('pairChanges', () => {
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
