import { buildFilterExpression } from './filters';

describe('GraphQL Filters', () => {
  describe('buildFilterExpression', () => {
    it('should return true for empty or null where clause', () => {
      expect(buildFilterExpression(null)).toBe('true');
      expect(buildFilterExpression(undefined)).toBe('true');
      expect(buildFilterExpression({})).toBe('true');
    });

    describe('comparison operators', () => {
      it('should handle _eq operator', () => {
        const where = { status: { _eq: 'active' } };
        expect(buildFilterExpression(where)).toBe('datum.status === "active"');
      });

      it('should handle _neq operator', () => {
        const where = { status: { _neq: 'inactive' } };
        expect(buildFilterExpression(where)).toBe('datum.status !== "inactive"');
      });

      it('should handle numeric comparisons', () => {
        expect(buildFilterExpression({ age: { _gt: 21 } })).toBe('datum.age > 21');
        expect(buildFilterExpression({ age: { _lt: 65 } })).toBe('datum.age < 65');
        expect(buildFilterExpression({ age: { _gte: 18 } })).toBe('datum.age >= 18');
        expect(buildFilterExpression({ age: { _lte: 100 } })).toBe('datum.age <= 100');
      });

      it('should handle _in operator', () => {
        const where = { status: { _in: ['active', 'pending'] } };
        expect(buildFilterExpression(where)).toBe('["active", "pending"].indexOf(datum.status) !== -1');
      });

      it('should handle _nin operator', () => {
        const where = { status: { _nin: ['deleted', 'archived'] } };
        expect(buildFilterExpression(where)).toBe('["deleted", "archived"].indexOf(datum.status) === -1');
      });

      it('should handle _is_null operator', () => {
        expect(buildFilterExpression({ email: { _is_null: true } })).toBe('datum.email == null');
        expect(buildFilterExpression({ email: { _is_null: false } })).toBe('datum.email != null');
      });
    });

    describe('logical operators', () => {
      it('should handle _and operator', () => {
        const where = {
          _and: [
            { status: { _eq: 'active' } },
            { age: { _gt: 21 } }
          ]
        };
        expect(buildFilterExpression(where)).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle _or operator', () => {
        const where = {
          _or: [
            { status: { _eq: 'active' } },
            { status: { _eq: 'pending' } }
          ]
        };
        expect(buildFilterExpression(where)).toBe('(datum.status === "active" || datum.status === "pending")');
      });

      it('should handle _not operator', () => {
        const where = {
          _not: { status: { _eq: 'deleted' } }
        };
        expect(buildFilterExpression(where)).toBe('!(datum.status === "deleted")');
      });

      it('should handle nested logical operators', () => {
        const where = {
          _and: [
            { _or: [{ status: { _eq: 'active' } }, { status: { _eq: 'pending' } }] },
            { age: { _gte: 18 } }
          ]
        };
        expect(buildFilterExpression(where)).toBe('((datum.status === "active" || datum.status === "pending") && datum.age >= 18)');
      });

      it('should handle mixed field conditions within _or', () => {
        // This tests operator precedence - multiple conditions are wrapped in parentheses
        const where = {
          _or: [
            { status: { _eq: 'active' } },
            { 
              age: { _gte: 18 },
              role: { _eq: 'admin' }
            }
          ]
        };
        // Multiple field conditions at same level are now wrapped in parentheses for clarity
        expect(buildFilterExpression(where)).toBe('(datum.status === "active" || (datum.age >= 18 && datum.role === "admin"))');
      });

      it('should demonstrate operator precedence with complex nesting', () => {
        // Test case: (A || B) && (C || D && E)
        const where = {
          _and: [
            { _or: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] },
            { _or: [
              { c: { _eq: 3 } },
              { d: { _eq: 4 }, e: { _eq: 5 } }  // These will be joined with &&
            ]}
          ]
        };
        expect(buildFilterExpression(where)).toBe('((datum.a === 1 || datum.b === 2) && (datum.c === 3 || (datum.d === 4 && datum.e === 5)))');
      });
    });

    describe('multiple fields', () => {
      it('should combine multiple field conditions with AND', () => {
        const where = {
          status: { _eq: 'active' },
          age: { _gt: 21 }
        };
        expect(buildFilterExpression(where)).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle multiple operators on same field', () => {
        const where = {
          age: { _gte: 18, _lt: 65 }
        };
        expect(buildFilterExpression(where)).toBe('(datum.age >= 18 && datum.age < 65)');
      });
    });

    describe('custom field variable', () => {
      it('should use custom field variable name', () => {
        const where = { status: { _eq: 'active' } };
        expect(buildFilterExpression(where, 'row')).toBe('row.status === "active"');
      });
    });

    describe('error handling', () => {
      it('should throw error for unknown operators', () => {
        const where = { status: { _unknown: 'value' } };
        expect(() => buildFilterExpression(where)).toThrow('Unknown operator: _unknown');
      });

      it('should throw error for non-array _in value', () => {
        const where = { status: { _in: 'not-an-array' } };
        expect(() => buildFilterExpression(where)).toThrow('_in operator requires an array');
      });

      it('should throw error for non-array _nin value', () => {
        const where = { status: { _nin: 'not-an-array' } };
        expect(() => buildFilterExpression(where)).toThrow('_nin operator requires an array');
      });
    });

    describe('edge cases', () => {
      it('should handle special characters in string values', () => {
        const where = { name: { _eq: 'O\'Brien' } };
        expect(buildFilterExpression(where)).toBe('datum.name === "O\'Brien"');
      });

      it('should handle boolean values', () => {
        const where = { is_active: { _eq: true } };
        expect(buildFilterExpression(where)).toBe('datum.is_active === true');
      });

      it('should handle null values', () => {
        const where = { status: { _eq: null } };
        expect(buildFilterExpression(where)).toBe('datum.status === null');
      });

      it('should handle numeric values', () => {
        const where = { count: { _eq: 0 } };
        expect(buildFilterExpression(where)).toBe('datum.count === 0');
      });
    });
  });
});