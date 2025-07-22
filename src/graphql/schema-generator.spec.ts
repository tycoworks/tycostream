import { generateSchema } from './schema-generator';
import type { SourceDefinition } from '../config/source-definition.types';

describe('generateSchema', () => {
  it('should generate basic schema structure', () => {
    const sources = new Map<string, SourceDefinition>();
    const schema = generateSchema(sources);
    
    expect(schema).toContain('type Query');
    expect(schema).toContain('ping: String');
    expect(schema).toContain('type Subscription');
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
    
    // Check Trade type
    expect(schema).toContain('type Trade {');
    expect(schema).toContain('id: Int!'); // Primary key is non-nullable
    expect(schema).toContain('symbol: String');
    expect(schema).toContain('price: Float');
    
    // Check TradeUpdate type
    expect(schema).toContain('type TradeUpdate {');
    expect(schema).toContain('operation: RowOperation!');
    expect(schema).toContain('trade: Trade');
    expect(schema).toContain('timestamp: String!');
    
    // Check subscription
    expect(schema).toContain('trades: TradeUpdate!');
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
    
    expect(schema).toContain('id: Float!'); // bigint -> Float (not Int)
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
    
    // Should convert live_pnl to LivePnl
    expect(schema).toContain('type LivePnl {');
    expect(schema).toContain('type LivePnlUpdate {');
    expect(schema).toContain('livePnl: LivePnl');
    expect(schema).toContain('live_pnl: LivePnlUpdate!');
  });

  it('should only include JSON scalar when needed', () => {
    const sourcesWithoutJson = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', type: 'integer' },
          { name: 'symbol', type: 'text' },
        ],
      }],
    ]);
    
    const schemaWithoutJson = generateSchema(sourcesWithoutJson);
    expect(schemaWithoutJson).not.toContain('scalar JSON');
    
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
    
    const schemaWithJson = generateSchema(sourcesWithJson);
    expect(schemaWithJson).toContain('scalar JSON');
    expect(schemaWithJson).toContain('data: JSON');
  });

  it('should handle unknown PostgreSQL types', () => {
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
    
    const schema = generateSchema(sources);
    
    // Should default to String for unknown types
    expect(schema).toContain('custom_field: String');
  });
});