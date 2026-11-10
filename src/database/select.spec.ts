import { buildSelect, nestRow } from './select.js';
import type { WhereClause } from '../common/types.js';
import {
  ComparisonOperator,
  OrderDirection,
  PostgresType,
} from '../common/types.js';
import type { Relationship, SourceDefinition } from '../config/source.types.js';

// A relationship to the one row of the source a column references
const toOne = (source: SourceDefinition, column: string): Relationship => ({
  source,
  column,
  relatedColumn: source.primaryKeyField,
  many: false,
});

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

const SELECT =
  'select "users"."id" as "id", "users"."name" as "name", "users"."active" as "active", "users"."rank" as "rank" from "users" as "users"';

function where(clause: WhereClause) {
  const { sql, parameters } = buildSelect(users, { where: clause });
  expect(sql.startsWith(`${SELECT} where `)).toBe(true);
  return { condition: sql.slice(`${SELECT} where `.length), parameters };
}

describe('buildSelect', () => {
  describe('the statement', () => {
    it('should select every column of the source when the selection names none, with no WHERE when there is no filter', () => {
      const all = { sql: SELECT, parameters: [] };
      expect(buildSelect(users)).toEqual(all);
      expect(buildSelect(users, {})).toEqual(all);
      expect(buildSelect(users, { where: {} })).toEqual(all);
    });

    it("should select only the columns named, and the key, in the source's order", () => {
      expect(buildSelect(users, { columns: ['rank', 'name'] })).toEqual({
        sql: 'select "users"."id" as "id", "users"."name" as "name", "users"."rank" as "rank" from "users" as "users"',
        parameters: [],
      });
    });

    it('should select the key alone when the selection names no columns', () => {
      expect(buildSelect(users, { columns: [] })).toEqual({
        sql: 'select "users"."id" as "id" from "users" as "users"',
        parameters: [],
      });
    });

    it('should reject selecting a column the source does not have', () => {
      expect(() => buildSelect(users, { columns: ['nope'] })).toThrow(
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
        buildSelect(source, { where: { 'we"ird': { _eq: 'x' } } }),
      ).toMatchObject({
        sql: 'select "odd""view"."we""ird" as "we""ird" from "odd""view" as "odd""view" where "odd""view"."we""ird" = $1',
        parameters: ['x'],
      });
    });
  });

  describe('joins', () => {
    const instruments: SourceDefinition = {
      name: 'instruments',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: PostgresType.Int4 },
        { name: 'name', type: PostgresType.Text },
      ],
    };
    const positions: SourceDefinition = {
      name: 'positions',
      primaryKeyField: 'instrument_id',
      fields: [
        { name: 'instrument_id', type: PostgresType.Int4 },
        { name: 'net_position', type: PostgresType.Int8 },
      ],
      relationships: new Map([
        ['instruments', toOne(instruments, 'instrument_id')],
      ]),
    };
    const trades: SourceDefinition = {
      name: 'trades',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', type: PostgresType.Int4 },
        { name: 'instrument_id', type: PostgresType.Int4 },
        { name: 'quantity', type: PostgresType.Int4 },
      ],
      relationships: new Map([
        ['positions', toOne(positions, 'instrument_id')],
      ]),
    };

    it('should left join each row a selected foreign key references, on its key, at any depth, each table and column named by its path', () => {
      expect(
        buildSelect(trades, {
          columns: ['quantity'],
          joins: {
            positions: {
              columns: ['net_position'],
              joins: { instruments: { columns: ['name'] } },
            },
          },
        }),
      ).toEqual({
        sql:
          'select "trades"."id" as "id", "trades"."quantity" as "quantity", ' +
          '"trades.positions"."instrument_id" as "positions.instrument_id", "trades.positions"."net_position" as "positions.net_position", ' +
          '"trades.positions.instruments"."id" as "positions.instruments.id", "trades.positions.instruments"."name" as "positions.instruments.name" ' +
          'from "trades" as "trades" ' +
          'left join "positions" as "trades.positions" on "trades.positions"."instrument_id" = "trades"."instrument_id" ' +
          'left join "instruments" as "trades.positions.instruments" on "trades.positions.instruments"."id" = "trades.positions"."instrument_id"',
        parameters: [],
      });
    });

    it("should filter and order by the selected rows' own columns", () => {
      expect(
        buildSelect(trades, {
          columns: ['quantity'],
          joins: { positions: { columns: ['net_position'] } },
          where: { quantity: { _gt: 0 } },
          orderBy: [{ id: OrderDirection.Asc }],
        }).sql,
      ).toMatch(/ where "trades"."quantity" > \$1 order by "trades"."id" asc$/);
    });

    it('should join a source to itself under its own path', () => {
      const employees: SourceDefinition = {
        name: 'employees',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: PostgresType.Int4 },
          { name: 'manager_id', type: PostgresType.Int4 },
        ],
      };
      employees.relationships = new Map([
        ['employees', toOne(employees, 'manager_id')],
      ]);

      expect(
        buildSelect(employees, {
          columns: ['id'],
          joins: { employees: { columns: ['id'] } },
        }).sql,
      ).toBe(
        'select "employees"."id" as "id", "employees.employees"."id" as "employees.id" ' +
          'from "employees" as "employees" ' +
          'left join "employees" as "employees.employees" on "employees.employees"."id" = "employees"."manager_id"',
      );
    });

    it("should reject joining many rows, which only one row's relationship can be", () => {
      const withTrades: SourceDefinition = {
        ...positions,
        relationships: new Map([
          [
            'trades',
            {
              source: trades,
              column: 'instrument_id',
              relatedColumn: 'instrument_id',
              many: true,
            },
          ],
        ]),
      };
      expect(() =>
        buildSelect(withTrades, { joins: { trades: { columns: ['id'] } } }),
      ).toThrow(
        "'trades' of 'positions' is many rows, which can't be joined yet",
      );
    });

    it("should reject joining a field that isn't a relationship's", () => {
      expect(() =>
        buildSelect(positions, { joins: { trades: { columns: ['id'] } } }),
      ).toThrow("Unknown relationship 'trades' of 'positions'");
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
        condition: `"users"."id" ${sqlOp} $1`,
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
          condition: `"users"."name" ${sqlOp} $1`,
          parameters: ['A%'],
        });
      },
    );

    it('should order text and booleans, and match booleans against a set', () => {
      expect(where({ name: { _gt: 'm' } })).toEqual({
        condition: '"users"."name" > $1',
        parameters: ['m'],
      });
      expect(where({ active: { _gte: false, _in: [true] } })).toEqual({
        condition: '("users"."active" >= $1 and "users"."active" in ($2))',
        parameters: [false, true],
      });
    });

    it('should compile _in and _nin to parameter lists', () => {
      expect(where({ name: { _in: ['a', 'b'] } })).toEqual({
        condition: '"users"."name" in ($1, $2)',
        parameters: ['a', 'b'],
      });
      expect(where({ name: { _nin: ['a'] } })).toEqual({
        condition: '"users"."name" not in ($1)',
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
        '"users"."name" is null',
      );
      expect(where({ name: { _is_null: false } }).condition).toBe(
        '"users"."name" is not null',
      );
    });

    it('should pass booleans and strings as parameters, never as SQL text', () => {
      expect(
        where({ active: { _eq: true }, name: { _eq: "x' or '1'='1" } }),
      ).toEqual({
        condition: '("users"."active" = $1 and "users"."name" = $2)',
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
      expect(
        buildSelect(users, { orderBy: [{ name: direction }] }),
      ).toMatchObject({
        sql: `${SELECT} order by "users"."name" ${sqlDirection}`,
        parameters: [],
      });
    });

    it('should order by each column in turn', () => {
      expect(
        buildSelect(users, {
          orderBy: [{ rank: OrderDirection.Desc }, { id: OrderDirection.Asc }],
        }).sql,
      ).toBe(`${SELECT} order by "users"."rank" desc, "users"."id" asc`);
    });

    it('should pass the limit and offset as parameters, after the filter', () => {
      expect(
        buildSelect(users, {
          where: { active: { _eq: true } },
          orderBy: [{ id: OrderDirection.Asc }],
          limit: 10,
          offset: 20,
        }),
      ).toMatchObject({
        sql: `${SELECT} where "users"."active" = $1 order by "users"."id" asc limit $2 offset $3`,
        parameters: [true, 10, 20],
      });
    });

    it('should reject ordering by a column the source does not have', () => {
      expect(() =>
        buildSelect(users, { orderBy: [{ nope: OrderDirection.Asc }] }),
      ).toThrow("Unknown field 'nope' to order by");
    });

    it('should reject a negative limit or offset', () => {
      expect(() => buildSelect(users, { limit: -1 })).toThrow(
        "'limit' can't be negative",
      );
      expect(() => buildSelect(users, { offset: -1 })).toThrow(
        "'offset' can't be negative",
      );
    });
  });

  describe('logic', () => {
    it('should AND several operators on one field, and several fields', () => {
      expect(where({ id: { _gte: 18, _lt: 65 }, name: { _eq: 'a' } })).toEqual({
        condition:
          '("users"."id" >= $1 and "users"."id" < $2 and "users"."name" = $3)',
        parameters: [18, 65, 'a'],
      });
    });

    it('should compile _and, _or and _not', () => {
      expect(
        where({ _and: [{ id: { _eq: 1 } }, { name: { _eq: 'a' } }] }),
      ).toEqual({
        condition: '("users"."id" = $1 and "users"."name" = $2)',
        parameters: [1, 'a'],
      });
      expect(where({ _or: [{ id: { _eq: 1 } }, { id: { _eq: 2 } }] })).toEqual({
        condition: '("users"."id" = $1 or "users"."id" = $2)',
        parameters: [1, 2],
      });
      expect(where({ _not: { name: { _eq: 'a' } } })).toEqual({
        condition: 'not "users"."name" = $1',
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
        condition:
          '(("users"."name" = $1 or "users"."name" = $2) and not "users"."id" < $3)',
        parameters: ['a', 'b', 18],
      });
    });
  });

  describe('enums', () => {
    it('should compare equality and sets as text', () => {
      expect(where({ rank: { _eq: 'gold' } })).toEqual({
        condition: '"users"."rank" = $1',
        parameters: ['gold'],
      });
      expect(where({ rank: { _in: ['gold', 'bronze'] } })).toEqual({
        condition: '"users"."rank" in ($1, $2)',
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
          condition: `"users"."rank" in (${expected.map((_, i) => `$${i + 1}`).join(', ')})`,
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
        buildSelect(users, { where: { rank: { _eq: 'diamond' } } }),
      ).toThrow("Invalid value 'diamond' for enum 'rank' on 'rank'");
      expect(() =>
        buildSelect(users, { where: { rank: { _in: ['gold', 'diamond'] } } }),
      ).toThrow("Invalid value 'diamond'");
    });
  });

  describe('validation', () => {
    it('should reject unknown fields before building any SQL', () => {
      expect(() => buildSelect(users, { where: { nope: { _eq: 1 } } })).toThrow(
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
        expect(() =>
          buildSelect(users, { where: { name: comparison } }),
        ).toThrow("can't compare with null; use '_is_null'");
      }
    });

    it('should reject unknown operators, such as _similar, which Materialize lacks', () => {
      expect(() =>
        buildSelect(users, {
          where: { name: { _similar: 'a' } } as unknown as WhereClause,
        }),
      ).toThrow("Unknown operator '_similar' on 'name'");
    });
  });
});

describe('nestRow', () => {
  it("should fold each joined row's columns, named by their path, into an object of its own, at any depth", () => {
    expect(
      nestRow({
        id: 1,
        quantity: 500,
        'positions.instrument_id': 1,
        'positions.net_position': 600,
        'positions.instruments.id': 1,
        'positions.instruments.name': 'Apple Inc.',
      }),
    ).toEqual({
      id: 1,
      quantity: 500,
      positions: {
        instrument_id: 1,
        net_position: 600,
        instruments: { id: 1, name: 'Apple Inc.' },
      },
    });
  });

  it('should make a joined row whose columns are all null, as when nothing matched, null', () => {
    expect(
      nestRow({
        id: 3,
        quantity: 10,
        'positions.instrument_id': null,
        'positions.net_position': null,
        'positions.instruments.id': null,
        'positions.instruments.name': null,
      }),
    ).toEqual({ id: 3, quantity: 10, positions: null });
  });

  it('should keep a joined row whose key is its only non-null column', () => {
    expect(
      nestRow({
        id: 1,
        'positions.instrument_id': 1,
        'positions.net_position': null,
      }),
    ).toEqual({ id: 1, positions: { instrument_id: 1, net_position: null } });
  });
});
