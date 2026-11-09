import { buildSelect } from './select.js';
import type { WhereClause } from '../common/types.js';
import {
  ComparisonOperator,
  OrderDirection,
  PostgresType,
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

const SELECT =
  'select "id" as "id", "name" as "name", "active" as "active", "rank" as "rank" from "users" as "users"';

function where(clause: WhereClause) {
  const { sql, parameters } = buildSelect(users, { where: clause });
  expect(sql.startsWith(`${SELECT} where `)).toBe(true);
  return { condition: sql.slice(`${SELECT} where `.length), parameters };
}

describe('buildSelect', () => {
  describe('the statement', () => {
    it('should select every column of the source, with no WHERE when there is no filter', () => {
      expect(buildSelect(users)).toEqual({ sql: SELECT, parameters: [] });
      expect(buildSelect(users, {})).toEqual({ sql: SELECT, parameters: [] });
      expect(buildSelect(users, { where: {} })).toEqual({
        sql: SELECT,
        parameters: [],
      });
    });

    it('should quote source and column names that contain quotes', () => {
      const source: SourceDefinition = {
        name: 'odd"view',
        primaryKeyField: 'we"ird',
        fields: [{ name: 'we"ird', type: PostgresType.Text }],
      };
      expect(
        buildSelect(source, { where: { 'we"ird': { _eq: 'x' } } }),
      ).toEqual({
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
      expect(buildSelect(users, { orderBy: [{ name: direction }] })).toEqual({
        sql: `${SELECT} order by "name" ${sqlDirection}`,
        parameters: [],
      });
    });

    it('should order by each column in turn', () => {
      expect(
        buildSelect(users, {
          orderBy: [{ rank: OrderDirection.Desc }, { id: OrderDirection.Asc }],
        }).sql,
      ).toBe(`${SELECT} order by "rank" desc, "id" asc`);
    });

    it('should pass the limit and offset as parameters, after the filter', () => {
      expect(
        buildSelect(users, {
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
