import { generateSchema } from './schema-generator';
import type { SourceDefinition } from '../config/source-definition.types';

describe('generateSchema', () => {
  it('should generate basic schema structure', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
    expect(schema).toContain('type Query');
    expect(schema).toContain('ping: String');
    expect(schema).toContain('type Subscription {');
    expect(schema).toContain('enum RowOperation');
    expect(schema).toContain('INSERT');
    expect(schema).toContain('UPDATE');
    expect(schema).toContain('DELETE');
  });

  it('should generate types for a simple source', () => {
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
    
    // Check subscription
    expect(schema).toContain('trades: tradesUpdate!');
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
    expect(schema).toContain('live_pnl: live_pnlUpdate!');
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