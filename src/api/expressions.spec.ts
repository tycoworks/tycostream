import { ExpressionBuilder } from './expressions';
import type { SourceDefinition } from '../config/source.types';
import { DataType } from '../config/source.types';

describe('GraphQL Expressions', () => {
  // Mock source definition without enums for basic tests
  const mockSourceDefinition: SourceDefinition = {
    name: 'test_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String },
      { name: 'status', dataType: DataType.String },
      { name: 'age', dataType: DataType.Integer },
      { name: 'email', dataType: DataType.String },
      { name: 'name', dataType: DataType.String },
      { name: 'value', dataType: DataType.Integer },
      { name: 'role', dataType: DataType.String },
      { name: 'active', dataType: DataType.Boolean },
      { name: 'price', dataType: DataType.Float },
      { name: 'a', dataType: DataType.Integer },
      { name: 'b', dataType: DataType.Integer },
      { name: 'c', dataType: DataType.Integer },
      { name: 'd', dataType: DataType.Integer },
      { name: 'e', dataType: DataType.Integer },
    ]
  };

  const builder = new ExpressionBuilder(mockSourceDefinition);

  describe('buildExpression generation', () => {
    it('should throw error for empty where clause', () => {
      expect(() => builder.buildExpression({})).toThrow('Cannot build expression from empty expression tree');
    });

    describe('comparison operators', () => {
      it('should handle _eq operator', () => {
        const where = { status: { _eq: 'active' } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status === "active"');
      });

      it('should handle _neq operator', () => {
        const where = { status: { _neq: 'inactive' } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status !== "inactive"');
      });

      it('should handle numeric comparisons', () => {
        expect(builder.buildExpression({ age: { _gt: 21 } })!.expression).toBe('datum.age > 21');
        expect(builder.buildExpression({ age: { _lt: 65 } })!.expression).toBe('datum.age < 65');
        expect(builder.buildExpression({ age: { _gte: 18 } })!.expression).toBe('datum.age >= 18');
        expect(builder.buildExpression({ age: { _lte: 100 } })!.expression).toBe('datum.age <= 100');
      });

      it('should handle _in operator', () => {
        const where = { status: { _in: ['active', 'pending'] } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('["active", "pending"].indexOf(datum.status) !== -1');
      });

      it('should handle _nin operator', () => {
        const where = { status: { _nin: ['deleted', 'archived'] } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('["deleted", "archived"].indexOf(datum.status) === -1');
      });

      it('should handle _is_null operator', () => {
        expect(builder.buildExpression({ email: { _is_null: true } })!.expression).toBe('datum.email == null');
        expect(builder.buildExpression({ email: { _is_null: false } })!.expression).toBe('datum.email != null');
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
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle _or operator', () => {
        const where = {
          _or: [
            { status: { _eq: 'active' } },
            { status: { _eq: 'pending' } }
          ]
        };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" || datum.status === "pending")');
      });

      it('should handle _not operator', () => {
        const where = {
          _not: { status: { _eq: 'deleted' } }
        };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('!(datum.status === "deleted")');
      });

      it('should handle nested logical operators', () => {
        const where = {
          _and: [
            { _or: [{ status: { _eq: 'active' } }, { status: { _eq: 'pending' } }] },
            { age: { _gte: 18 } }
          ]
        };
        const filter = builder.buildExpression(where);
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
        const filter = builder.buildExpression(where);
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
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('((datum.a === 1 || datum.b === 2) && (datum.c === 3 || (datum.d === 4 && datum.e === 5)))');
      });
    });

    describe('multiple fields', () => {
      it('should combine multiple field conditions with AND', () => {
        const where = {
          status: { _eq: 'active' },
          age: { _gt: 21 }
        };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "active" && datum.age > 21)');
      });

      it('should handle multiple operators on same field', () => {
        const where = {
          age: { _gte: 18, _lt: 65 }
        };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.age >= 18 && datum.age < 65)');
      });
    });


    describe('error handling', () => {
      it('should throw error for unknown operators', () => {
        const where = { status: { _unknown: 'value' } };
        expect(() => builder.buildExpression(where)).toThrow('Unknown operator: _unknown');
      });

      it('should throw error for non-array _in value', () => {
        const where = { status: { _in: 'not-an-array' } };
        expect(() => builder.buildExpression(where)).toThrow('_in operator requires an array');
      });

      it('should throw error for non-array _nin value', () => {
        const where = { status: { _nin: 'not-an-array' } };
        expect(() => builder.buildExpression(where)).toThrow('_nin operator requires an array');
      });
    });

    describe('edge cases', () => {
      it('should handle special characters in string values', () => {
        const where = { name: { _eq: 'O\'Brien' } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.name === "O\'Brien"');
      });

      it('should handle boolean values', () => {
        const where = { is_active: { _eq: true } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.is_active === true');
      });

      it('should handle null values', () => {
        const where = { status: { _eq: null } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status === null');
      });

      it('should handle numeric values', () => {
        const where = { count: { _eq: 0 } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.count === 0');
      });
    });
  });

  describe('ExpressionBuilder.buildExpression function', () => {
    it('should throw error for empty where clause', () => {
      expect(() => builder.buildExpression({})).toThrow('Cannot build expression from empty expression tree');
    });

    it('should build filter with evaluate function and fields', () => {
      const where = { status: { _eq: 'active' }, age: { _gt: 18 } };
      const filter = builder.buildExpression(where);
      
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
      const filter = builder.buildExpression(where);
      
      expect(Array.from(filter!.fields).sort()).toEqual(['age', 'priority', 'status']);
    });

    it('should handle _not operator', () => {
      const where = { _not: { status: { _eq: 'deleted' } } };
      const filter = builder.buildExpression(where);
      
      expect(Array.from(filter!.fields)).toEqual(['status']);
      expect(filter!.evaluate({ status: 'active' })).toBe(true);
      expect(filter!.evaluate({ status: 'deleted' })).toBe(false);
    });

    it('should throw error for invalid expressions', () => {
      // This would be caught during compilation
      const where = { status: { _unknown: 'value' } };
      expect(() => builder.buildExpression(where)).toThrow('Unknown operator: _unknown');
    });
  });

  describe('enum optimization', () => {
    const sourceDefinition: SourceDefinition = {
      name: 'orders',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', dataType: DataType.String },
        {
          name: 'status',
          dataType: DataType.String,
          enumType: {
            name: 'order_status',
            values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled']
          }
        },
        {
          name: 'priority',
          dataType: DataType.String,
          enumType: {
            name: 'priority_level',
            values: ['low', 'medium', 'high']
          }
        }
      ]
    };

    const enumBuilder = new ExpressionBuilder(sourceDefinition);

    describe('ordinal comparisons with small enums', () => {
      it('should generate ternary chain for _gt with small enum', () => {
        const where = { priority: { _gt: 'low' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) > 0');
      });

      it('should generate ternary chain for _gt with second-to-last value', () => {
        const where = { priority: { _gt: 'medium' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) > 1');
      });

      it('should generate ternary chain for _gt with last value', () => {
        const where = { priority: { _gt: 'high' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) > 2');
      });

      it('should generate ternary chain for _gte', () => {
        const where = { priority: { _gte: 'medium' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) >= 1');
      });

      it('should generate ternary chain for _lt', () => {
        const where = { priority: { _lt: 'high' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) < 2');
      });

      it('should generate ternary chain for _lt with second value', () => {
        const where = { priority: { _lt: 'medium' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) < 1');
      });

      it('should generate ternary chain for _lt with first value', () => {
        const where = { priority: { _lt: 'low' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) < 0');
      });

      it('should generate ternary chain for _lte', () => {
        const where = { priority: { _lte: 'medium' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) <= 1');
      });
    });

    describe('ordinal comparisons with 5-value enums', () => {
      it('should generate ternary chain for _gt with 5-value enum', () => {
        const where = { status: { _gt: 'processing' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) > 1');
      });

      it('should generate ternary chain for _gte', () => {
        const where = { status: { _gte: 'shipped' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) >= 2');
      });

      it('should generate ternary chain for _lt', () => {
        const where = { status: { _lt: 'shipped' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) < 2');
      });

      it('should generate ternary chain for _lte', () => {
        const where = { status: { _lte: 'processing' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('(datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) <= 1');
      });
    });

    describe('enum with larger than 5 values', () => {
      const largeEnumSource: SourceDefinition = {
        name: 'tickets',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          {
            name: 'status',
            dataType: DataType.String,
            enumType: {
              name: 'ticket_status',
              values: ['new', 'open', 'pending', 'hold', 'solved', 'closed', 'merged', 'deleted']
            }
          }
        ]
      };

      const largeEnumBuilder = new ExpressionBuilder(largeEnumSource);

      it('should generate ternary chain for enums with more than 5 values', () => {
        const where = { status: { _gt: 'pending' } };
        const filter = largeEnumBuilder.buildExpression(where);
        // Should generate ternary chain instead of boolean OR
        expect(filter!.expression).toContain('datum.status === "new" ? 0');
        expect(filter!.expression).toContain('datum.status === "open" ? 1');
        expect(filter!.expression).toContain('> 2'); // pending is at index 2
      });
    });

    describe('non-enum fields', () => {
      it('should use standard comparison for non-enum fields', () => {
        const where = { id: { _gt: 100 } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('datum.id > 100');
      });

      it('should use standard comparison when no source definition provided', () => {
        const where = { status: { _gt: 'pending' } };
        const filter = builder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status > "pending"');
      });
    });

    describe('invalid enum values', () => {
      it('should generate false for invalid enum value in comparison', () => {
        const where = { priority: { _gt: 'invalid_value' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('false');
      });
    });

    describe('equality operators with enums', () => {
      it('should use direct equality for _eq with enums', () => {
        const where = { status: { _eq: 'shipped' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status === "shipped"');
      });

      it('should use direct inequality for _neq with enums', () => {
        const where = { status: { _neq: 'cancelled' } };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('datum.status !== "cancelled"');
      });
    });

    describe('complex expressions with enum optimization', () => {
      it('should optimize enum comparisons within _and', () => {
        const where = {
          _and: [
            { priority: { _gte: 'medium' } },
            { status: { _lt: 'delivered' } }
          ]
        };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('((datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) >= 1 && (datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) < 3)');
      });

      it('should optimize enum comparisons within _or', () => {
        const where = {
          _or: [
            { priority: { _gt: 'medium' } },
            { status: { _eq: 'pending' } }
          ]
        };
        const filter = enumBuilder.buildExpression(where);
        expect(filter!.expression).toBe('((datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) > 1 || datum.status === "pending")');
      });
    });
  });

  describe('ExpressionBuilder class', () => {
    const sourceDefinition = {
      name: 'orders',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', dataType: 1 },
        {
          name: 'status',
          dataType: 6, // String
          enumType: {
            name: 'order_status',
            values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled']
          }
        },
        {
          name: 'priority',
          dataType: 6, // String
          enumType: {
            name: 'priority_level',
            values: ['low', 'medium', 'high']
          }
        }
      ]
    };

    it('should create expressions with enum optimization', () => {
      const builder = new ExpressionBuilder(sourceDefinition);
      const where = { priority: { _gt: 'low' } };
      const filter = builder.buildExpression(where);

      expect(filter.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) > 0');
    });

    it('should handle complex expressions', () => {
      const builder = new ExpressionBuilder(sourceDefinition);
      const where = {
        _and: [
          { status: { _gte: 'shipped' } },
          { priority: { _neq: 'low' } }
        ]
      };
      const filter = builder.buildExpression(where);

      expect(filter.expression).toBe('((datum.status === "pending" ? 0 : datum.status === "processing" ? 1 : datum.status === "shipped" ? 2 : datum.status === "delivered" ? 3 : datum.status === "cancelled" ? 4 : -1) >= 2 && datum.priority !== "low")');
    });

    it('should reuse the same builder for multiple expressions', () => {
      const builder = new ExpressionBuilder(sourceDefinition);

      const filter1 = builder.buildExpression({ status: { _eq: 'shipped' } });
      expect(filter1.expression).toBe('datum.status === "shipped"');

      const filter2 = builder.buildExpression({ priority: { _lt: 'high' } });
      expect(filter2.expression).toBe('(datum.priority === "low" ? 0 : datum.priority === "medium" ? 1 : datum.priority === "high" ? 2 : -1) < 2');
    });
  });
});