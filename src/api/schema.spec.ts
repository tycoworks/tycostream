import { generateSchema } from './schema';
import type { SourceDefinition } from '../config/source.types';

describe('generateSchema', () => {
  it('should generate root types even with no sources', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
    // Should have all three root types
    expect(schema).toContain('type Query {');
    expect(schema).toContain('type Mutation {');
    expect(schema).toContain('type Subscription {');
  });

  it('should define RowOperation enum for subscription events', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
    expect(schema).toContain('enum RowOperation');
    expect(schema).toContain('INSERT');
    expect(schema).toContain('UPDATE');
    expect(schema).toContain('DELETE');
  });

  it('should define Trigger type for trigger operations', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
    expect(schema).toContain('type Trigger {');
    expect(schema).toContain('name: String!');
    expect(schema).toContain('webhook: String!');
    expect(schema).toContain('match: String!');
    expect(schema).toContain('unmatch: String');
  });

  it('should define comparison input types for filtering', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
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
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
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
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
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
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
    // Should have trigger input type
    expect(schema).toContain('input tradesTriggerInput {');
    expect(schema).toContain('name: String!');
    expect(schema).toContain('webhook: String!');
    expect(schema).toContain('match: tradesWhere!');
    expect(schema).toContain('unmatch: tradesWhere');
  });

  it('should generate filter input types that work for both subscriptions and triggers', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
          { name: 'price', type: 'numeric' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
    // Should have Where input type with field comparisons
    expect(schema).toContain('input tradesWhere {');
    expect(schema).toContain('id: IntComparison');
    expect(schema).toContain('symbol: StringComparison');
    expect(schema).toContain('price: FloatComparison');
    
    // Should have logical operators
    expect(schema).toContain('_and: [tradesWhere!]');
    expect(schema).toContain('_or: [tradesWhere!]');
    expect(schema).toContain('_not: tradesWhere');
  });

  it('should generate source object types and update types', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
          { name: 'price', type: 'numeric' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
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
    expect(schema).toContain('trades(where: tradesWhere): tradesUpdate!');
  });

  it('should handle PostgreSQL type mappings correctly', () => {
    const sources = new Map<string, SourceDefinition>([
      ['test_types', {
        name: 'test_types',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'bigint' },
          { name: 'active', type: 'boolean' },
          { name: 'count', type: 'smallint' },
          { name: 'amount', type: 'double precision' },
          { name: 'created_at', type: 'timestamp without time zone' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
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
          { name: 'account_id', type: 'integer' },
          { name: 'pnl', type: 'numeric' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sources);
    
    // Should use source name as-is
    expect(schema).toContain('type live_pnl {');
    expect(schema).toContain('type live_pnlUpdate {');
    expect(schema).toContain('data: live_pnl');
    expect(schema).toContain('live_pnl(where: live_pnlWhere): live_pnlUpdate!');
  });

  it('should treat JSON/JSONB fields as String', () => {
    const sourcesWithJson = new Map<string, SourceDefinition>([
      ['events', {
        name: 'events',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'data', type: 'jsonb' },
        ],
      }],
    ]);
    
    const schema = generateSchema(sourcesWithJson);
    expect(schema).not.toContain('scalar JSON');
    expect(schema).toContain('data: String'); // JSON is treated as String
  });

  it('should throw error for unknown PostgreSQL types', () => {
    const sources = new Map<string, SourceDefinition>([
      ['custom', {
        name: 'custom',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'custom_field', type: 'unknown_type' },
        ],
      }],
    ]);
    
    // Should fail fast for unknown types
    expect(() => generateSchema(sources)).toThrow('Unsupported PostgreSQL type: unknown_type');
  });
});