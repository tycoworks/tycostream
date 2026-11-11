import { Statement } from './statement.js';
import type { Selection, WhereClause } from '../common/types.js';
import {
  ComparisonOperator,
  OrderDirection,
  PostgresType,
  StreamMode,
} from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';

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

// A query's statement of the source and selection
const queryOf = (source: SourceDefinition, selection: Selection = {}) =>
  new Statement(source, selection, StreamMode.Snapshot);

const SELECT =
  'select "id" as "id", "name" as "name", "active" as "active", "rank" as "rank" from "users" as "users"';

function where(clause: WhereClause) {
  const { sql, parameters } = queryOf(users, { where: clause });
  expect(sql.startsWith(`${SELECT} where `)).toBe(true);
  return { condition: sql.slice(`${SELECT} where `.length), parameters };
}

describe('Statement', () => {
  describe('the statement', () => {
    it('should select every column of the source when the selection names none, with no WHERE when there is no filter', () => {
      const all = {
        sql: SELECT,
        parameters: [],
        columns: ['id', 'name', 'active', 'rank'],
      };
      expect(queryOf(users)).toMatchObject(all);
      expect(queryOf(users, {})).toMatchObject(all);
      expect(queryOf(users, { where: {} })).toMatchObject(all);
    });

    it("should select only the columns named, and the key, in the source's order", () => {
      expect(queryOf(users, { columns: ['rank', 'name'] })).toMatchObject({
        sql: 'select "id" as "id", "name" as "name", "rank" as "rank" from "users" as "users"',
        parameters: [],
        columns: ['id', 'name', 'rank'],
      });
    });

    it('should select the key alone when the selection names no columns', () => {
      expect(queryOf(users, { columns: [] })).toMatchObject({
        sql: 'select "id" as "id" from "users" as "users"',
        parameters: [],
        columns: ['id'],
      });
    });

    it('should keep the source it reads and the mode it was built for, which its stream reads it in', () => {
      expect(new Statement(users, {}, StreamMode.Live)).toMatchObject({
        source: users,
        mode: StreamMode.Live,
      });
    });

    it('should unpack one of its rows as its own columns, with null for a missing value, whatever else the row carries', () => {
      expect(
        queryOf(users, { columns: ['name'] }).unpack({
          id: 7,
          mz_timestamp: 42,
          email: 'a',
        }),
      ).toEqual({ id: 7, name: null });
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
        queryOf(source, { where: { 'we"ird': { _eq: 'x' } } }),
      ).toMatchObject({
        sql: 'select "we""ird" as "we""ird" from "odd""view" as "odd""view" where "we""ird" = $1',
        parameters: ['x'],
      });
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
      expect(queryOf(users, { orderBy: [{ name: direction }] })).toMatchObject({
        sql: `${SELECT} order by "name" ${sqlDirection}`,
        parameters: [],
      });
    });

    it('should order by each column in turn', () => {
      expect(
        queryOf(users, {
          orderBy: [{ rank: OrderDirection.Desc }, { id: OrderDirection.Asc }],
        }).sql,
      ).toBe(`${SELECT} order by "rank" desc, "id" asc`);
    });

    it('should pass the limit and offset as parameters, after the filter', () => {
      expect(
        queryOf(users, {
          where: { active: { _eq: true } },
          orderBy: [{ id: OrderDirection.Asc }],
          limit: 10,
          offset: 20,
        }),
      ).toMatchObject({
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
