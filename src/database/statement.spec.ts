import { Statement } from './statement.js';
import type { Selection, WhereClause } from '../common/types.js';
import {
  ComparisonOperator,
  OrderDirection,
  PostgresType,
  StreamMode,
} from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { addForeignKey } from '../config/sources.config.js';

const rank = { name: 'rank', values: ['bronze', 'silver', 'gold', 'platinum'] };

const users: SourceDefinition = {
  name: 'users',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'name', type: PostgresType.Text },
    { name: 'active', type: PostgresType.Bool },
    { name: 'rank', type: PostgresType.Text, enumType: rank },
  ],
};

// Instruments, their positions, and the positions' trades, each related to
// the next by a foreign key
const instruments: SourceDefinition = {
  name: 'instruments',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'name', type: PostgresType.Text },
  ],
  relationships: new Map(),
};
const positions: SourceDefinition = {
  name: 'positions',
  primaryKeyField: 'instrument_id',
  fields: [
    { name: 'instrument_id', type: PostgresType.Int4 },
    { name: 'symbol', type: PostgresType.Text },
    { name: 'currency_code', type: PostgresType.Text },
    { name: 'net_position', type: PostgresType.Int8 },
  ],
  relationships: new Map(),
};
const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'instrument_id', type: PostgresType.Int4 },
    { name: 'account_id', type: PostgresType.Int4 },
    { name: 'quantity', type: PostgresType.Int4 },
  ],
  relationships: new Map(),
};
// A trade's account, beside its position; and a position's currency, which
// the position references by a column that isn't its key
const accounts: SourceDefinition = {
  name: 'accounts',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'name', type: PostgresType.Text },
  ],
  relationships: new Map(),
};
const currencies: SourceDefinition = {
  name: 'currencies',
  primaryKeyField: 'code',
  fields: [
    { name: 'code', type: PostgresType.Text },
    { name: 'name', type: PostgresType.Text },
  ],
  relationships: new Map(),
};
addForeignKey(positions, 'instrument_id', instruments);
addForeignKey(positions, 'currency_code', currencies);
addForeignKey(trades, 'instrument_id', positions);
addForeignKey(trades, 'account_id', accounts);

// A query's statement of the source and selection
const queryOf = (source: SourceDefinition, selection: Selection = {}) =>
  new Statement(source, selection, StreamMode.Snapshot);

// The columns a statement gives a row of one of its sources
const columnsOf = (statement: Statement, source = 0) =>
  Object.keys(
    statement.unpack({ __source: source, __keys: [], __row: {} }).row,
  );

// The source's rows a statement selects, as its CTE, with no row numbers:
// a subscription's
function sourceRowsOf(source: SourceDefinition, selection: Selection = {}) {
  const { sql, parameters } = new Statement(source, selection, StreamMode.Live);
  const start = 'with "__source_0" as (select "__rows".* from (';
  expect(sql.startsWith(start)).toBe(true);
  return {
    sql: sql.slice(start.length, sql.indexOf(') as "__rows"')),
    parameters,
  };
}

// Every column of users, selected from the source
const SELECT =
  'select "id" as "id", "name" as "name", "active" as "active", "rank" as "rank" from "users" as "users"';

// The filter on users a statement applies
function where(clause: WhereClause) {
  const { sql, parameters } = sourceRowsOf(users, { where: clause });
  expect(sql.startsWith(`${SELECT} where `)).toBe(true);
  return { condition: sql.slice(`${SELECT} where `.length), parameters };
}

describe('Statement', () => {
  describe('the statement', () => {
    it("should read a query's rows from its source's rows, as a CTE, numbered in their order, and give each as one JSON object of its values as text, in that order", () => {
      expect(
        queryOf(users, {
          columns: ['name'],
          orderBy: [{ name: OrderDirection.Asc }],
        }),
      ).toMatchObject({
        sql:
          'with "__source_0" as (select "__rows".* from (select "id" as "id", "name" as "name", ' +
          'row_number() over(order by "name" asc) as "__row_number" ' +
          'from "users" as "users" order by "name" asc) as "__rows") ' +
          'select 0 as "__source", "__source_0"."__row_number" as "__row_number", jsonb_build_array(cast("__source_0"."id" as text)) as "__keys", jsonb_build_object(\'id\', cast("__source_0"."id" as text), ' +
          '\'name\', cast("__source_0"."name" as text)) as "__row" ' +
          'from "__source_0" as "__source_0" order by "__row_number"',
        parameters: [],
      });
    });

    it("should read a subscription's rows the same way, with no numbers, as its rows come unordered", () => {
      expect(
        new Statement(
          users,
          { columns: ['name'], orderBy: [{ name: OrderDirection.Asc }] },
          StreamMode.Live,
        ).sql,
      ).toBe(
        'with "__source_0" as (select "__rows".* from (select "id" as "id", "name" as "name" ' +
          'from "users" as "users" order by "name" asc) as "__rows") ' +
          'select 0 as "__source", jsonb_build_array(cast("__source_0"."id" as text)) as "__keys", jsonb_build_object(\'id\', cast("__source_0"."id" as text), ' +
          '\'name\', cast("__source_0"."name" as text)) as "__row" ' +
          'from "__source_0" as "__source_0"',
      );
    });

    it('should select every column of the source when the selection names none, with no WHERE when there is no filter', () => {
      const all = { sql: SELECT, parameters: [] };
      expect(sourceRowsOf(users)).toEqual(all);
      expect(sourceRowsOf(users, { where: {} })).toEqual(all);
      expect(columnsOf(queryOf(users))).toEqual([
        'id',
        'name',
        'active',
        'rank',
      ]);
    });

    it("should select only the columns named, and the key, in the source's order", () => {
      expect(sourceRowsOf(users, { columns: ['rank', 'name'] }).sql).toBe(
        'select "id" as "id", "name" as "name", "rank" as "rank" from "users" as "users"',
      );
      expect(columnsOf(queryOf(users, { columns: ['rank', 'name'] }))).toEqual([
        'id',
        'name',
        'rank',
      ]);
    });

    it('should select the key alone when the selection names no columns', () => {
      expect(sourceRowsOf(users, { columns: [] }).sql).toBe(
        'select "id" as "id" from "users" as "users"',
      );
    });

    it('should keep the source it reads and the mode it was built for, which its stream reads it in', () => {
      expect(new Statement(users, {}, StreamMode.Live)).toMatchObject({
        source: users,
        mode: StreamMode.Live,
      });
    });

    it("should unpack one of its rows: its path and keys, its key's field, and each of its columns' values parsed from its text by the column's type", () => {
      expect(
        queryOf(users).unpack({
          __source: 0,
          __keys: ['7'],
          __row: { id: '7', name: 'a', active: 't', rank: 'gold' },
        }),
      ).toEqual({
        path: [],
        keys: [7],
        keyField: 'id',
        row: { id: 7, name: 'a', active: true, rank: 'gold' },
      });
    });

    it('should unpack a null or missing value as null, whatever else the row carries', () => {
      expect(
        queryOf(users, { columns: ['name', 'active'] }).unpack({
          __source: 0,
          __keys: ['7'],
          __row: { id: '7', name: null, email: 'a' },
          mz_timestamp: 42,
        }).row,
      ).toEqual({ id: 7, name: null, active: null });
    });

    it('should unpack a null key as null, as a source can declare a key the database lets be null', () => {
      expect(
        queryOf(users).unpack({
          __source: 0,
          __keys: [null],
          __row: { id: null },
        }),
      ).toMatchObject({ keys: [null], row: { id: null } });
    });

    it('should reject selecting a column the source does not have', () => {
      expect(() => queryOf(users, { columns: ['nope'] })).toThrow(
        "Unknown field 'nope' to select",
      );
    });

    it('should quote source and column names that contain quotes', () => {
      const source: SourceDefinition = {
        name: 'odd"view',
        primaryKeyField: 'we"ird',
        fields: [{ name: 'we"ird', type: PostgresType.Text }],
      };
      expect(
        sourceRowsOf(source, { where: { 'we"ird': { _eq: 'x' } } }),
      ).toEqual({
        sql: 'select "we""ird" as "we""ird" from "odd""view" as "odd""view" where "we""ird" = $1',
        parameters: ['x'],
      });
    });
  });

  describe('related rows', () => {
    // The latest trades, each with its position and the position's instrument
    const selection: Selection = {
      columns: ['quantity'],
      where: { quantity: { _gt: 0 } },
      orderBy: [{ id: OrderDirection.Desc }],
      limit: 50,
      offset: 10,
      relationships: {
        positions: {
          columns: ['symbol'],
          relationships: { instruments: { columns: ['name'] } },
        },
      },
    };

    it("should left join each related row onto its row after the row's filter, order and limit, at any depth, its columns named by its path", () => {
      expect(new Statement(trades, selection, StreamMode.Live)).toMatchObject({
        sql:
          'with "__source_0" as (select "__rows".*, ' +
          '"positions"."instrument_id" as "positions.instrument_id", "positions"."symbol" as "positions.symbol", ' +
          '"positions.instruments"."id" as "positions.instruments.id", "positions.instruments"."name" as "positions.instruments.name" ' +
          'from (select "id" as "id", "instrument_id" as "instrument_id", "quantity" as "quantity" ' +
          'from "trades" as "trades" where "quantity" > $1 order by "id" desc limit $2 offset $3) as "__rows" ' +
          'left join "positions" as "positions" on "positions"."instrument_id" = "__rows"."instrument_id" ' +
          'left join "instruments" as "positions.instruments" on "positions.instruments"."id" = "positions"."instrument_id") ' +
          'select 0 as "__source", jsonb_build_array(cast("__source_0"."id" as text)) as "__keys", jsonb_build_object(\'id\', cast("__source_0"."id" as text), ' +
          '\'quantity\', cast("__source_0"."quantity" as text), ' +
          '\'positions.instrument_id\', cast("__source_0"."positions.instrument_id" as text), ' +
          '\'positions.symbol\', cast("__source_0"."positions.symbol" as text), ' +
          '\'positions.instruments.id\', cast("__source_0"."positions.instruments.id" as text), ' +
          '\'positions.instruments.name\', cast("__source_0"."positions.instruments.name" as text)) as "__row" ' +
          'from "__source_0" as "__source_0"',
        parameters: [0, 50, 10],
      });
    });

    it("should number a query's rows inside the source's rows, before the joins, and order the statement by those numbers", () => {
      const { sql } = queryOf(trades, selection);
      expect(sql).toContain(
        '"quantity" as "quantity", row_number() over(order by "id" desc) as "__row_number" from "trades" as "trades" where',
      );
      expect(sql).toMatch(/order by "__row_number"$/);
    });

    it("should join sibling related rows onto the same row, reading each join's column, selected or not", () => {
      const statement = queryOf(trades, {
        columns: ['quantity'],
        relationships: {
          positions: { columns: ['symbol'] },
          accounts: { columns: ['name'] },
        },
      });

      expect(statement.sql).toContain(
        'from (select "id" as "id", "instrument_id" as "instrument_id", "account_id" as "account_id", "quantity" as "quantity", ',
      );
      expect(statement.sql).toContain(
        'left join "positions" as "positions" on "positions"."instrument_id" = "__rows"."instrument_id" ' +
          'left join "accounts" as "accounts" on "accounts"."id" = "__rows"."account_id"',
      );
      expect(columnsOf(statement)).toEqual([
        'id',
        'quantity',
        'positions.instrument_id',
        'positions.symbol',
        'accounts.id',
        'accounts.name',
      ]);
    });

    it("should join a related row's own related row on its holder's column, from the holder's table, selected or not", () => {
      const statement = queryOf(trades, {
        relationships: {
          positions: {
            columns: ['symbol'],
            relationships: { currencies: { columns: ['name'] } },
          },
        },
      });

      expect(statement.sql).toContain(
        'left join "currencies" as "positions.currencies" on "positions.currencies"."code" = "positions"."currency_code"',
      );
      expect(columnsOf(statement)).not.toContain('positions.currency_code');
    });

    it("should read the column a row's join matches on, but keep it out of the row unless it's selected", () => {
      expect(columnsOf(queryOf(trades, selection))).toEqual([
        'id',
        'quantity',
        'positions.instrument_id',
        'positions.symbol',
        'positions.instruments.id',
        'positions.instruments.name',
      ]);
      expect(
        columnsOf(
          queryOf(trades, {
            ...selection,
            columns: ['instrument_id', 'quantity'],
          }),
        ).slice(0, 3),
      ).toEqual(['id', 'instrument_id', 'quantity']);
    });

    it("should unpack a related row's columns, named by its path, each parsed by its source's type", () => {
      expect(
        queryOf(trades, selection).unpack({
          __source: 0,
          __keys: ['7'],
          __row: {
            id: '7',
            quantity: '500',
            'positions.instrument_id': '1',
            'positions.symbol': 'AAPL',
            'positions.instruments.id': '1',
            'positions.instruments.name': 'Apple Inc.',
          },
        }).row,
      ).toEqual({
        id: 7,
        quantity: 500,
        'positions.instrument_id': 1,
        'positions.symbol': 'AAPL',
        'positions.instruments.id': 1,
        'positions.instruments.name': 'Apple Inc.',
      });
    });

    it("should unpack a trade with no position as its position's columns all null", () => {
      expect(
        queryOf(trades, selection).unpack({
          __source: 0,
          __keys: ['9'],
          __row: {
            id: '9',
            quantity: '50',
            'positions.instrument_id': null,
            'positions.symbol': null,
            'positions.instruments.id': null,
            'positions.instruments.name': null,
          },
        }).row,
      ).toEqual({
        id: 9,
        quantity: 50,
        'positions.instrument_id': null,
        'positions.symbol': null,
        'positions.instruments.id': null,
        'positions.instruments.name': null,
      });
    });

    it('should refuse a filter, order, limit or offset on a relationship to one row', () => {
      expect(() =>
        queryOf(trades, { relationships: { positions: { limit: 1 } } }),
      ).toThrow(
        "'positions' is a relationship to one row; it takes no where, order_by, limit or offset",
      );
    });

    it("should refuse a related row's unknown relationship or column", () => {
      expect(() =>
        queryOf(trades, {
          relationships: { positions: { relationships: { orders: {} } } },
        }),
      ).toThrow("Unknown relationship 'orders' of 'positions'");
      expect(() =>
        queryOf(trades, {
          relationships: { positions: { columns: ['nope'] } },
        }),
      ).toThrow("Unknown field 'nope' to select");
    });

    it('should reject a relationship the source does not have', () => {
      expect(() => queryOf(trades, { relationships: { orders: {} } })).toThrow(
        "Unknown relationship 'orders' of 'trades'",
      );
    });
  });

  describe('lists', () => {
    // Positions, each with its latest two trades
    const selection: Selection = {
      columns: ['symbol'],
      relationships: {
        trades: {
          columns: ['quantity'],
          orderBy: [{ id: OrderDirection.Desc }],
          limit: 2,
        },
      },
    };

    it("should read each list's rows for each row of its parent, filtered, ordered and limited per parent, tag each source's rows with its number, and stack them, a query's in their numbers' order", () => {
      expect(queryOf(positions, selection)).toMatchObject({
        sql:
          'with "__source_0" as (select "__rows".* from (select "instrument_id" as "instrument_id", "symbol" as "symbol", ' +
          'row_number() over() as "__row_number" from "positions" as "positions") as "__rows"), ' +
          '"__source_1" as (select "__source_0"."instrument_id" as "__key_0", "__rows".* from "__source_0" as "__source_0" cross join lateral ' +
          '(select "id" as "id", "quantity" as "quantity", row_number() over(order by "id" desc) as "__row_number" ' +
          'from "trades" as "trades" where "trades"."instrument_id" = "__source_0"."instrument_id" ' +
          'order by "id" desc limit $1) as "__rows") ' +
          'select 0 as "__source", "__source_0"."__row_number" as "__row_number", ' +
          'jsonb_build_array(cast("__source_0"."instrument_id" as text)) as "__keys", ' +
          'jsonb_build_object(\'instrument_id\', cast("__source_0"."instrument_id" as text), ' +
          '\'symbol\', cast("__source_0"."symbol" as text)) as "__row" from "__source_0" as "__source_0" ' +
          'union all ' +
          'select 1 as "__source", "__source_1"."__row_number" as "__row_number", ' +
          'jsonb_build_array(cast("__source_1"."__key_0" as text), cast("__source_1"."id" as text)) as "__keys", ' +
          'jsonb_build_object(\'id\', cast("__source_1"."id" as text), ' +
          '\'quantity\', cast("__source_1"."quantity" as text)) as "__row" from "__source_1" as "__source_1" ' +
          'order by "__row_number"',
        parameters: [2],
      });
    });

    it("should leave a subscription's rows unnumbered, as a list's would renumber at every insert", () => {
      const { sql } = new Statement(positions, selection, StreamMode.Live);

      expect(sql).not.toContain('__row_number');
      expect(sql).toContain('cross join lateral');
    });

    it("should read a list within a list for each row of the inner list's source", () => {
      const { sql } = queryOf(instruments, {
        relationships: {
          positions: { relationships: { trades: { columns: ['quantity'] } } },
        },
      });

      expect(sql).toContain(
        '"__source_2" as (select "__source_1"."__key_0" as "__key_0", "__source_1"."instrument_id" as "__key_1", "__rows".* from "__source_1" as "__source_1" cross join lateral',
      );
      expect(sql).toContain(
        'where "trades"."instrument_id" = "__source_1"."instrument_id"',
      );
    });

    it("should read a list under a related row for each row, matched on the related row's key", () => {
      const { sql } = queryOf(trades, {
        relationships: {
          positions: { relationships: { trades: { columns: ['quantity'] } } },
        },
      });

      expect(sql).toContain(
        'where "trades"."instrument_id" = "__source_0"."positions.instrument_id"',
      );
    });

    it("should join a list's own related rows onto its rows, reading each join's column", () => {
      const { sql } = queryOf(positions, {
        relationships: {
          trades: {
            columns: ['quantity'],
            relationships: { accounts: { columns: ['name'] } },
          },
        },
      });

      expect(sql).toContain(
        '(select "id" as "id", "account_id" as "account_id", "quantity" as "quantity", ',
      );
      expect(sql).toContain(
        'left join "accounts" as "accounts" on "accounts"."id" = "__rows"."account_id"',
      );
    });

    it("should unpack a list's row by its source's number: its list's path, its parent's keys then its own, and that source's columns", () => {
      const statement = queryOf(positions, selection);

      expect(
        statement.unpack({
          __source: 1,
          __keys: ['1', '8'],
          __row: { id: '8', quantity: '100' },
        }),
      ).toEqual({
        path: ['trades'],
        keys: [1, 8],
        keyField: 'id',
        row: { id: 8, quantity: 100 },
      });
      expect(columnsOf(statement)).toEqual(['instrument_id', 'symbol']);
      expect(columnsOf(statement, 1)).toEqual(['id', 'quantity']);
    });

    it("should give a list under a related row its path through the related row, and keys from the selected row's, as a related row adds none", () => {
      const statement = queryOf(trades, {
        relationships: {
          positions: { relationships: { trades: { columns: ['quantity'] } } },
        },
      });

      expect(
        statement.unpack({
          __source: 1,
          __keys: ['7', '8'],
          __row: { id: '8', quantity: '100' },
        }),
      ).toMatchObject({ path: ['positions', 'trades'], keys: [7, 8] });
    });

    it("should parse each key by its column's type, a parent's text key too, three levels deep", () => {
      const statement = queryOf(currencies, {
        relationships: { positions: { relationships: { trades: {} } } },
      });

      expect(
        statement.unpack({
          __source: 2,
          __keys: ['USD', '1', '8'],
          __row: { id: '8' },
        }),
      ).toMatchObject({ path: ['positions', 'trades'], keys: ['USD', 1, 8] });
    });
  });

  describe('operators', () => {
    it.each([
      [ComparisonOperator.Eq, '='],
      [ComparisonOperator.Neq, '<>'],
      [ComparisonOperator.Gt, '>'],
      [ComparisonOperator.Gte, '>='],
      [ComparisonOperator.Lt, '<'],
      [ComparisonOperator.Lte, '<='],
    ])('should compile %s to %s with the value as a parameter', (op, sqlOp) => {
      expect(where({ id: { [op]: 21 } })).toEqual({
        condition: `"id" ${sqlOp} $1`,
        parameters: [21],
      });
    });

    it.each([
      [ComparisonOperator.Like, 'like'],
      [ComparisonOperator.Nlike, 'not like'],
      [ComparisonOperator.Ilike, 'ilike'],
      [ComparisonOperator.Nilike, 'not ilike'],
      [ComparisonOperator.Regex, '~'],
      [ComparisonOperator.Nregex, '!~'],
      [ComparisonOperator.Iregex, '~*'],
      [ComparisonOperator.Niregex, '!~*'],
    ])(
      'should compile %s to %s with the pattern as a parameter',
      (op, sqlOp) => {
        expect(where({ name: { [op]: 'A%' } })).toEqual({
          condition: `"name" ${sqlOp} $1`,
          parameters: ['A%'],
        });
      },
    );

    it('should order text and booleans, and match booleans against a set', () => {
      expect(where({ name: { _gt: 'm' } })).toEqual({
        condition: '"name" > $1',
        parameters: ['m'],
      });
      expect(where({ active: { _gte: false, _in: [true] } })).toEqual({
        condition: '("active" >= $1 and "active" in ($2))',
        parameters: [false, true],
      });
    });

    it('should compile _in and _nin to parameter lists', () => {
      expect(where({ name: { _in: ['a', 'b'] } })).toEqual({
        condition: '"name" in ($1, $2)',
        parameters: ['a', 'b'],
      });
      expect(where({ name: { _nin: ['a'] } })).toEqual({
        condition: '"name" not in ($1)',
        parameters: ['a'],
      });
    });

    it('should compile an empty _in to false and an empty _nin to true', () => {
      expect(where({ id: { _in: [] } })).toEqual({
        condition: 'false',
        parameters: [],
      });
      expect(where({ id: { _nin: [] } })).toEqual({
        condition: 'true',
        parameters: [],
      });
    });

    it('should compile _is_null', () => {
      expect(where({ name: { _is_null: true } }).condition).toBe(
        '"name" is null',
      );
      expect(where({ name: { _is_null: false } }).condition).toBe(
        '"name" is not null',
      );
    });

    it('should pass booleans and strings as parameters, never as SQL text', () => {
      expect(
        where({ active: { _eq: true }, name: { _eq: "x' or '1'='1" } }),
      ).toEqual({
        condition: '("active" = $1 and "name" = $2)',
        parameters: [true, "x' or '1'='1"],
      });
    });
  });

  describe('order, limit and offset', () => {
    it.each([
      [OrderDirection.Asc, 'asc'],
      [OrderDirection.AscNullsFirst, 'asc nulls first'],
      [OrderDirection.AscNullsLast, 'asc nulls last'],
      [OrderDirection.Desc, 'desc'],
      [OrderDirection.DescNullsFirst, 'desc nulls first'],
      [OrderDirection.DescNullsLast, 'desc nulls last'],
    ])('should compile %s to ORDER BY ... %s', (direction, sqlDirection) => {
      expect(sourceRowsOf(users, { orderBy: [{ name: direction }] })).toEqual({
        sql: `${SELECT} order by "name" ${sqlDirection}`,
        parameters: [],
      });
    });

    it('should order by each column in turn', () => {
      expect(
        sourceRowsOf(users, {
          orderBy: [{ rank: OrderDirection.Desc }, { id: OrderDirection.Asc }],
        }).sql,
      ).toBe(`${SELECT} order by "rank" desc, "id" asc`);
    });

    it('should pass the limit and offset as parameters, after the filter', () => {
      expect(
        sourceRowsOf(users, {
          where: { active: { _eq: true } },
          orderBy: [{ id: OrderDirection.Asc }],
          limit: 10,
          offset: 20,
        }),
      ).toEqual({
        sql: `${SELECT} where "active" = $1 order by "id" asc limit $2 offset $3`,
        parameters: [true, 10, 20],
      });
    });

    it('should reject ordering by a column the source does not have', () => {
      expect(() =>
        queryOf(users, { orderBy: [{ nope: OrderDirection.Asc }] }),
      ).toThrow("Unknown field 'nope' to order by");
    });

    it('should reject a negative limit or offset', () => {
      expect(() => queryOf(users, { limit: -1 })).toThrow(
        "'limit' can't be negative",
      );
      expect(() => queryOf(users, { offset: -1 })).toThrow(
        "'offset' can't be negative",
      );
    });
  });

  describe('logic', () => {
    it('should AND several operators on one field, and several fields', () => {
      expect(where({ id: { _gte: 18, _lt: 65 }, name: { _eq: 'a' } })).toEqual({
        condition: '("id" >= $1 and "id" < $2 and "name" = $3)',
        parameters: [18, 65, 'a'],
      });
    });

    it('should compile _and, _or and _not', () => {
      expect(
        where({ _and: [{ id: { _eq: 1 } }, { name: { _eq: 'a' } }] }),
      ).toEqual({
        condition: '("id" = $1 and "name" = $2)',
        parameters: [1, 'a'],
      });
      expect(where({ _or: [{ id: { _eq: 1 } }, { id: { _eq: 2 } }] })).toEqual({
        condition: '("id" = $1 or "id" = $2)',
        parameters: [1, 2],
      });
      expect(where({ _not: { name: { _eq: 'a' } } })).toEqual({
        condition: 'not "name" = $1',
        parameters: ['a'],
      });
    });

    it('should nest', () => {
      expect(
        where({
          _and: [
            { _or: [{ name: { _eq: 'a' } }, { name: { _eq: 'b' } }] },
            { _not: { id: { _lt: 18 } } },
          ],
        }),
      ).toEqual({
        condition: '(("name" = $1 or "name" = $2) and not "id" < $3)',
        parameters: ['a', 'b', 18],
      });
    });
  });

  describe('enums', () => {
    it('should compare equality and sets as text', () => {
      expect(where({ rank: { _eq: 'gold' } })).toEqual({
        condition: '"rank" = $1',
        parameters: ['gold'],
      });
      expect(where({ rank: { _in: ['gold', 'bronze'] } })).toEqual({
        condition: '"rank" in ($1, $2)',
        parameters: ['gold', 'bronze'],
      });
    });

    it.each([
      [ComparisonOperator.Gt, 'silver', ['gold', 'platinum']],
      [ComparisonOperator.Gte, 'silver', ['silver', 'gold', 'platinum']],
      [ComparisonOperator.Lt, 'silver', ['bronze']],
      [ComparisonOperator.Lte, 'silver', ['bronze', 'silver']],
      [
        ComparisonOperator.Gte,
        'bronze',
        ['bronze', 'silver', 'gold', 'platinum'],
      ],
      [
        ComparisonOperator.Lte,
        'platinum',
        ['bronze', 'silver', 'gold', 'platinum'],
      ],
    ])(
      'should order by declared position: %s %s matches %j',
      (op, value, expected) => {
        expect(where({ rank: { [op]: value } })).toEqual({
          condition: `"rank" in (${expected.map((_, i) => `$${i + 1}`).join(', ')})`,
          parameters: expected,
        });
      },
    );

    it('should compile an ordering with nothing on its side to false', () => {
      expect(where({ rank: { _gt: 'platinum' } }).condition).toBe('false');
      expect(where({ rank: { _lt: 'bronze' } }).condition).toBe('false');
    });

    it('should reject values the enum does not have', () => {
      expect(() =>
        queryOf(users, { where: { rank: { _eq: 'diamond' } } }),
      ).toThrow("Invalid value 'diamond' for enum 'rank' on 'rank'");
      expect(() =>
        queryOf(users, { where: { rank: { _in: ['gold', 'diamond'] } } }),
      ).toThrow("Invalid value 'diamond'");
    });
  });

  describe('validation', () => {
    it('should reject unknown fields before building any SQL', () => {
      expect(() => queryOf(users, { where: { nope: { _eq: 1 } } })).toThrow(
        "Unknown field 'nope'",
      );
    });

    it('should reject null as a value to compare with, pointing to _is_null', () => {
      for (const comparison of [
        { _eq: null },
        { _neq: null },
        { _gt: null },
        { _in: ['a', null] },
        { _nin: [null] },
        { _like: null },
      ]) {
        expect(() => queryOf(users, { where: { name: comparison } })).toThrow(
          "can't compare with null; use '_is_null'",
        );
      }
    });

    it('should reject unknown operators, such as _similar, which Materialize lacks', () => {
      expect(() =>
        queryOf(users, {
          where: { name: { _similar: 'a' } } as unknown as WhereClause,
        }),
      ).toThrow("Unknown operator '_similar' on 'name'");
    });
  });
});
