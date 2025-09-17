import { generateSchema } from './schema';
import type { SourceDefinition, SourceConfiguration } from '../config/source.types';
import { DataType } from '../config/source.types';

describe('generateSchema', () => {
  // Helper to create a SourceConfiguration for tests
  const createConfig = (sources: Map<string, SourceDefinition> = new Map()): SourceConfiguration => ({
    sources,
    enums: new Map()
  });

  it('should generate root types even with no sources', () => {
    const schema = generateSchema(createConfig());
    
    // Should have all three root types
    expect(schema).toContain('type Query {');
    expect(schema).toContain('type Mutation {');
    expect(schema).toContain('type Subscription {');
  });

  it('should define RowOperation enum for subscription events', () => {
    const schema = generateSchema(createConfig());
    
    expect(schema).toContain('enum RowOperation');
    expect(schema).toContain('INSERT');
    expect(schema).toContain('UPDATE');
    expect(schema).toContain('DELETE');
  });

  it('should define Trigger type for trigger operations', () => {
    const schema = generateSchema(createConfig());
    
    expect(schema).toContain('type Trigger {');
    expect(schema).toContain('name: String!');
    expect(schema).toContain('webhook: String!');
    expect(schema).toContain('fire: String!');
    expect(schema).toContain('clear: String');
  });

  it('should define comparison input types for filtering', () => {
    const schema = generateSchema(createConfig());
    
    // String comparisons
    expect(schema).toContain('input StringComparison');
    expect(schema).toContain('_eq: String');
    expect(schema).toContain('_neq: String');
    expect(schema).toContain('_in: [String!]');
    expect(schema).toContain('_is_null: Boolean');
    
    // Numeric comparisons
    expect(schema).toContain('input IntComparison');
    expect(schema).toContain('_gt: Int');
    expect(schema).toContain('_lt: Int');
    expect(schema).toContain('_gte: Int');
    expect(schema).toContain('_lte: Int');
    
    expect(schema).toContain('input FloatComparison');
    expect(schema).toContain('input BooleanComparison');
  });

  it('should generate query fields for triggers', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Should have trigger query fields
    expect(schema).toContain('trades_triggers: [Trigger!]!');
    expect(schema).toContain('trades_trigger(name: String!): Trigger');
  });

  it('should generate mutation fields for triggers', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Should have trigger mutation fields
    expect(schema).toContain('create_trades_trigger(input: tradesTriggerInput!): Trigger!');
    expect(schema).toContain('delete_trades_trigger(name: String!): Trigger!');
  });

  it('should generate trigger input types for each source', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Should have trigger input type
    expect(schema).toContain('input tradesTriggerInput {');
    expect(schema).toContain('name: String!');
    expect(schema).toContain('webhook: String!');
    expect(schema).toContain('fire: tradesExpression!');
    expect(schema).toContain('clear: tradesExpression');
  });

  it('should generate expression input types that work for both subscriptions and triggers', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
          { name: 'price', dataType: DataType.Float },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Should have Expression input type with field comparisons
    expect(schema).toContain('input tradesExpression {');
    expect(schema).toContain('id: IntComparison');
    expect(schema).toContain('symbol: StringComparison');
    expect(schema).toContain('price: FloatComparison');
    
    // Should have logical operators
    expect(schema).toContain('_and: [tradesExpression!]');
    expect(schema).toContain('_or: [tradesExpression!]');
    expect(schema).toContain('_not: tradesExpression');
  });

  it('should generate source object types and update types', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
          { name: 'price', dataType: DataType.Float },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Check trades type
    expect(schema).toContain('type trades {');
    expect(schema).toContain('id: Int!'); // Primary key is non-nullable
    expect(schema).toContain('symbol: String');
    expect(schema).toContain('price: Float');
    
    // Check tradesUpdate type
    expect(schema).toContain('type tradesUpdate {');
    expect(schema).toContain('operation: RowOperation!');
    expect(schema).toContain('data: trades');
    expect(schema).toContain('fields: [String!]');
    
    // Should have subscription field
    expect(schema).toContain('trades(where: tradesExpression): tradesUpdate!');
  });

  it('should handle DataType mappings correctly', () => {
    const sources = new Map<string, SourceDefinition>([
      ['test_types', {
        name: 'test_types',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.BigInt },
          { name: 'active', dataType: DataType.Boolean },
          { name: 'count', dataType: DataType.Integer },
          { name: 'amount', dataType: DataType.Float },
          { name: 'created_at', dataType: DataType.Timestamp },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    expect(schema).toContain('id: String!'); // bigint -> String to preserve precision
    expect(schema).toContain('active: Boolean');
    expect(schema).toContain('count: Int');
    expect(schema).toContain('amount: Float');
    expect(schema).toContain('created_at: String');
  });

  it('should handle underscored source names', () => {
    const sources = new Map<string, SourceDefinition>([
      ['live_pnl', {
        name: 'live_pnl',
        primaryKeyField: 'account_id',
        fields: [
          { name: 'account_id', dataType: DataType.Integer },
          { name: 'pnl', dataType: DataType.Float },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sources));
    
    // Should use source name as-is
    expect(schema).toContain('type live_pnl {');
    expect(schema).toContain('type live_pnlUpdate {');
    expect(schema).toContain('data: live_pnl');
    expect(schema).toContain('live_pnl(where: live_pnlExpression): live_pnlUpdate!');
  });

  it('should treat JSON/JSONB fields as String', () => {
    const sourcesWithJson = new Map<string, SourceDefinition>([
      ['events', {
        name: 'events',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'data', dataType: DataType.JSON },
        ],
      }],
    ]);
    
    const schema = generateSchema(createConfig(sourcesWithJson));
    expect(schema).not.toContain('scalar JSON');
    expect(schema).toContain('data: String'); // JSON is treated as String
  });

  it('should not throw error for all DataTypes', () => {
    const sources = new Map<string, SourceDefinition>([
      ['custom', {
        name: 'custom',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'custom_field', dataType: DataType.String },
        ],
      }],
    ]);

    // Should not throw since all fields have valid DataTypes
    expect(() => generateSchema(createConfig(sources))).not.toThrow();
  });

  it('should generate GraphQL enum types from configuration', () => {
    const tradeSideEnum = {
      name: 'trade_side',
      values: ['buy', 'sell']
    };
    const orderStatusEnum = {
      name: 'order_status',
      values: ['pending', 'filled', 'cancelled']
    };

    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'symbol', dataType: DataType.String },
          {
            name: 'side',
            dataType: DataType.String,
            enumType: tradeSideEnum
          },
          {
            name: 'status',
            dataType: DataType.String,
            enumType: orderStatusEnum
          }
        ],
      }],
    ]);

    const config: SourceConfiguration = {
      sources,
      enums: new Map([
        ['trade_side', tradeSideEnum],
        ['order_status', orderStatusEnum]
      ])
    };

    const schema = generateSchema(config);

    // Should generate enum type definitions
    expect(schema).toContain('enum trade_side {');
    expect(schema).toContain('buy');
    expect(schema).toContain('sell');

    expect(schema).toContain('enum order_status {');
    expect(schema).toContain('pending');
    expect(schema).toContain('filled');
    expect(schema).toContain('cancelled');

    // Fields should use enum types
    expect(schema).toContain('side: trade_side');
    expect(schema).toContain('status: order_status');

    // Enum fields should use StringComparison for filtering
    expect(schema).toContain('side: StringComparison');
    expect(schema).toContain('status: StringComparison');
  });

  it('should handle shared enum definitions across sources', () => {
    const enumDef = {
      name: 'shared_status',
      values: ['active', 'inactive']
    };

    const sources = new Map<string, SourceDefinition>([
      ['source1', {
        name: 'source1',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'status', dataType: DataType.String, enumType: enumDef }
        ],
      }],
      ['source2', {
        name: 'source2',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'state', dataType: DataType.String, enumType: enumDef }
        ],
      }],
    ]);

    const config: SourceConfiguration = {
      sources,
      enums: new Map([['shared_status', enumDef]])
    };

    const schema = generateSchema(config);

    // Should only define the enum once
    const enumMatches = schema.match(/enum shared_status \{/g);
    expect(enumMatches).toHaveLength(1);

    // Both sources should reference the same enum
    expect(schema).toContain('status: shared_status');
    expect(schema).toContain('state: shared_status');
  });
});