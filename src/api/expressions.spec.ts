import { buildExpression } from './expressions';

describe('GraphQL Expressions', () => {
  describe('buildExpression generation', () => {
    it('should throw error for empty where clause', () => {
      expect(() => buildExpression({})).toThrow('Cannot build expression from empty expression tree');
    });

    describe('comparison operators', () => {
      it('should handle _eq operator', () => {
        const where = { status: { _eq: 'active' } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.status === "active"');
      });

      it('should handle _neq operator', () => {
        const where = { status: { _neq: 'inactive' } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.status !== "inactive"');
      });

      it('should handle numeric comparisons', () => {
        expect(buildExpression({ age: { _gt: 21 } })!.expression).toBe('datum.age > 21');
        expect(buildExpression({ age: { _lt: 65 } })!.expression).toBe('datum.age < 65');
        expect(buildExpression({ age: { _gte: 18 } })!.expression).toBe('datum.age >= 18');
        expect(buildExpression({ age: { _lte: 100 } })!.expression).toBe('datum.age <= 100');
      });

      it('should handle _in operator', () => {
        const where = { status: { _in: ['active', 'pending'] } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('["active", "pending"].indexOf(datum.status) !== -1');
      });

      it('should handle _nin operator', () => {
        const where = { status: { _nin: ['deleted', 'archived'] } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('["deleted", "archived"].indexOf(datum.status) === -1');
      });

      it('should handle _is_null operator', () => {
        expect(buildExpression({ email: { _is_null: true } })!.expression).toBe('datum.email == null');
        expect(buildExpression({ email: { _is_null: false } })!.expression).toBe('datum.email != null');
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
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle _or operator', () => {
        const where = {
          _or: [
            { status: { _eq: 'active' } },
            { status: { _eq: 'pending' } }
          ]
        };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" || datum.status === "pending")');
      });

      it('should handle _not operator', () => {
        const where = {
          _not: { status: { _eq: 'deleted' } }
        };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('!(datum.status === "deleted")');
      });

      it('should handle nested logical operators', () => {
        const where = {
          _and: [
            { _or: [{ status: { _eq: 'active' } }, { status: { _eq: 'pending' } }] },
            { age: { _gte: 18 } }
          ]
        };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('((datum.status === "active" || datum.status === "pending") && datum.age >= 18)');
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
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" || (datum.age >= 18 && datum.role === "admin"))');
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
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('((datum.a === 1 || datum.b === 2) && (datum.c === 3 || (datum.d === 4 && datum.e === 5)))');
      });
    });

    describe('multiple fields', () => {
      it('should combine multiple field conditions with AND', () => {
        const where = {
          status: { _eq: 'active' },
          age: { _gt: 21 }
        };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle multiple operators on same field', () => {
        const where = {
          age: { _gte: 18, _lt: 65 }
        };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('(datum.age >= 18 && datum.age < 65)');
      });
    });


    describe('error handling', () => {
      it('should throw error for unknown operators', () => {
        const where = { status: { _unknown: 'value' } };
        expect(() => buildExpression(where)).toThrow('Unknown operator: _unknown');
      });

      it('should throw error for non-array _in value', () => {
        const where = { status: { _in: 'not-an-array' } };
        expect(() => buildExpression(where)).toThrow('_in operator requires an array');
      });

      it('should throw error for non-array _nin value', () => {
        const where = { status: { _nin: 'not-an-array' } };
        expect(() => buildExpression(where)).toThrow('_nin operator requires an array');
      });
    });

    describe('edge cases', () => {
      it('should handle special characters in string values', () => {
        const where = { name: { _eq: 'O\'Brien' } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.name === "O\'Brien"');
      });

      it('should handle boolean values', () => {
        const where = { is_active: { _eq: true } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.is_active === true');
      });

      it('should handle null values', () => {
        const where = { status: { _eq: null } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.status === null');
      });

      it('should handle numeric values', () => {
        const where = { count: { _eq: 0 } };
        const filter = buildExpression(where);
        expect(filter!.expression).toBe('datum.count === 0');
      });
    });
  });

  describe('buildExpression function', () => {
    it('should throw error for empty where clause', () => {
      expect(() => buildExpression({})).toThrow('Cannot build expression from empty expression tree');
    });

    it('should build filter with evaluate function and fields', () => {
      const where = { status: { _eq: 'active' }, age: { _gt: 18 } };
      const filter = buildExpression(where);
      
      expect(filter).not.toBeNull();
      expect(Array.from(filter!.fields)).toEqual(['status', 'age']);
      expect(typeof filter!.evaluate).toBe('function');
      expect(filter!.expression).toBe('(datum.status === "active" && datum.age > 18)');
      
      // Test the evaluate function
      expect(filter!.evaluate({ status: 'active', age: 20 })).toBe(true);
      expect(filter!.evaluate({ status: 'inactive', age: 20 })).toBe(false);
      expect(filter!.evaluate({ status: 'active', age: 15 })).toBe(false);
    });

    it('should collect fields from nested logical operators', () => {
      const where = {
        _and: [
          { _or: [{ status: { _eq: 'active' } }, { priority: { _eq: 'high' } }] },
          { age: { _gte: 18 } }
        ]
      };
      const filter = buildExpression(where);
      
      expect(Array.from(filter!.fields).sort()).toEqual(['age', 'priority', 'status']);
    });

    it('should handle _not operator', () => {
      const where = { _not: { status: { _eq: 'deleted' } } };
      const filter = buildExpression(where);
      
      expect(Array.from(filter!.fields)).toEqual(['status']);
      expect(filter!.evaluate({ status: 'active' })).toBe(true);
      expect(filter!.evaluate({ status: 'deleted' })).toBe(false);
    });

    it('should throw error for invalid expressions', () => {
      // This would be caught during compilation
      const where = { status: { _unknown: 'value' } };
      expect(() => buildExpression(where)).toThrow('Unknown operator: _unknown');
    });
  });
});