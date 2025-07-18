import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MaterializeProtocolHandler } from './materialize';
import type { SourceSchema } from '../core/schema';

// Mock the logger
vi.mock('../core/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn()
    }))
  }
}));

describe('MaterializeProtocolHandler', () => {
  let handler: MaterializeProtocolHandler;
  let mockSchema: SourceSchema;

  beforeEach(() => {
    mockSchema = {
      typeDefs: 'type Test { id: ID! name: String! value: Int }',
      fields: [
        { name: 'id', type: 'ID!', nullable: false, isPrimaryKey: true },
        { name: 'name', type: 'String!', nullable: false, isPrimaryKey: false },
        { name: 'value', type: 'Int', nullable: true, isPrimaryKey: false }
      ],
      primaryKeyField: 'id',
      sourceName: 'test_view'
    };

    handler = new MaterializeProtocolHandler(mockSchema);
  });

  describe('constructor', () => {
    it('should initialize with correct column names', () => {
      // Column names should be: mz_timestamp, mz_state, id (key), name, value (non-keys)
      // We can't directly access private columnNames, but we can test through parseLine
      const testLine = '1234567890\tupsert\t123\ttest\t42';
      const result = handler.parseLine(testLine);
      
      expect(result).toBeDefined();
      expect(result?.row).toEqual({
        id: '123',
        name: 'test',
        value: '42'
      });
    });

    it('should handle schemas with only primary key field', () => {
      const singleFieldSchema: SourceSchema = {
        typeDefs: 'type Test { id: ID! }',
        fields: [
          { name: 'id', type: 'ID!', nullable: false, isPrimaryKey: true }
        ],
        primaryKeyField: 'id',
        sourceName: 'single_field_view'
      };

      const singleFieldHandler = new MaterializeProtocolHandler(singleFieldSchema);
      const query = singleFieldHandler.createSubscribeQuery();
      expect(query).toContain('single_field_view');
    });
  });

  describe('createSubscribeQuery', () => {
    it('should create correct SUBSCRIBE query', () => {
      const query = handler.createSubscribeQuery();
      
      expect(query).toBe('SUBSCRIBE TO test_view ENVELOPE UPSERT (KEY (id)) WITH (SNAPSHOT)');
    });

    it('should use the correct primary key field', () => {
      const customKeySchema: SourceSchema = {
        ...mockSchema,
        primaryKeyField: 'name',
        fields: mockSchema.fields.map(f => ({
          ...f,
          isPrimaryKey: f.name === 'name'
        }))
      };

      const customHandler = new MaterializeProtocolHandler(customKeySchema);
      const query = customHandler.createSubscribeQuery();
      
      expect(query).toContain('KEY (name)');
    });
  });

  describe('parseLine', () => {
    it('should parse upsert line correctly', () => {
      const line = '1234567890\tupsert\t123\ttest name\t42';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.timestamp).toBe(BigInt(1234567890));
      expect(result?.isDelete).toBe(false);
      expect(result?.row).toEqual({
        id: '123',
        name: 'test name',
        value: '42'
      });
    });

    it('should parse delete line correctly', () => {
      const line = '1234567890\tdelete\t123\ttest name\t42';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.timestamp).toBe(BigInt(1234567890));
      expect(result?.isDelete).toBe(true);
      expect(result?.row).toEqual({
        id: '123',
        name: 'test name',
        value: '42'
      });
    });

    it('should handle null values (\\N)', () => {
      const line = '1234567890\tupsert\t123\t\\N\t\\N';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.row).toEqual({
        id: '123',
        name: null,
        value: null
      });
    });

    it('should return null for empty lines', () => {
      expect(handler.parseLine('')).toBeNull();
      expect(handler.parseLine('  ')).toBeNull();
      expect(handler.parseLine('\t')).toBeNull();
    });

    it('should return null for invalid lines', () => {
      // Too few fields
      expect(handler.parseLine('1234567890')).toBeNull();
      
      // Missing timestamp
      expect(handler.parseLine('\tupsert\t123')).toBeNull();
      
      // Missing mz_state
      expect(handler.parseLine('1234567890\t\t123')).toBeNull();
    });

    it('should handle lines with only timestamp and mz_state', () => {
      // Valid line but no data fields
      const result = handler.parseLine('1234567890\tupsert');
      
      expect(result).toBeDefined();
      expect(result?.timestamp).toBe(BigInt(1234567890));
      expect(result?.isDelete).toBe(false);
      expect(result?.row).toEqual({}); // Empty row object
    });

    it('should handle lines with fewer fields than expected', () => {
      // Only has id field, missing name and value
      const line = '1234567890\tupsert\t123';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.row).toEqual({
        id: '123'
      });
    });

    it('should handle lines with more fields than expected', () => {
      // Has extra fields that should be ignored
      const line = '1234567890\tupsert\t123\ttest\t42\textra1\textra2';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.row).toEqual({
        id: '123',
        name: 'test',
        value: '42'
      });
    });

    it('should handle tab characters in field values', () => {
      // Note: This is an edge case - real Materialize probably escapes tabs
      const line = '1234567890\tupsert\t123\tname with\ttab\t42';
      const result = handler.parseLine(line);

      // This will actually parse incorrectly due to the tab
      // The parser will see "name with" as the name and "tab" as the value
      expect(result).toBeDefined();
      expect(result?.row.name).toBe('name with');
      expect(result?.row.value).toBe('tab');
    });
  });
});