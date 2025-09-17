import { MaterializeProtocolHandler } from './materialize';
import type { SourceDefinition, EnumType } from '../config/source.types';
import { DataType } from '../config/source.types';
import { DatabaseRowUpdateType } from './types';

describe('MaterializeProtocolHandler', () => {
  let handler: MaterializeProtocolHandler;
  let mockSourceDef: SourceDefinition;

  beforeEach(() => {
    mockSourceDef = {
      name: 'test',
      primaryKeyField: 'id',
      fields: [
        { name: 'id', dataType: DataType.String },
        { name: 'name', dataType: DataType.String },
        { name: 'value', dataType: DataType.Integer }
      ]
    };

    handler = new MaterializeProtocolHandler(mockSourceDef, 'test_view');
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
        value: 42  // Should be parsed as integer
      });
    });

    it('should handle schemas with only primary key field', () => {
      const singleFieldDef: SourceDefinition = {
        name: 'single',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String }
        ]
      };

      const singleFieldHandler = new MaterializeProtocolHandler(singleFieldDef, 'single_field_view');
      const query = singleFieldHandler.createSubscribeQuery();
      expect(query).toContain('single_field_view');
    });
  });

  describe('createSubscribeQuery', () => {
    it('should create correct SUBSCRIBE query', () => {
      const query = handler.createSubscribeQuery();
      
      expect(query).toBe('SUBSCRIBE (SELECT id, name, value FROM test_view) ENVELOPE UPSERT (KEY (id)) WITH (SNAPSHOT)');
    });

    it('should use the correct primary key field', () => {
      const customKeyDef: SourceDefinition = {
        name: 'custom',
        primaryKeyField: 'name',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'name', dataType: DataType.String },
          { name: 'value', dataType: DataType.Integer }
        ]
      };

      const customHandler = new MaterializeProtocolHandler(customKeyDef, 'custom_view');
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
      expect(result?.updateType).toBe(DatabaseRowUpdateType.Upsert);
      expect(result?.row).toEqual({
        id: '123',
        name: 'test name',
        value: 42
      });
    });

    it('should parse delete line correctly', () => {
      const line = '1234567890\tdelete\t123\ttest name\t42';
      const result = handler.parseLine(line);

      expect(result).toBeDefined();
      expect(result?.timestamp).toBe(BigInt(1234567890));
      expect(result?.updateType).toBe(DatabaseRowUpdateType.Delete);
      expect(result?.row).toEqual({
        id: '123',
        name: 'test name',
        value: 42
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
      expect(result?.updateType).toBe(DatabaseRowUpdateType.Upsert);
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
        value: 42
      });
    });

    it('should handle tab characters in field values', () => {
      // Note: This is an edge case - real Materialize probably escapes tabs
      const line = '1234567890\tupsert\t123\tname with\ttab\t42';
      const result = handler.parseLine(line);

      // This will actually parse incorrectly due to the tab
      // The parser will see "name with" as the name and "tab" as the value
      // Since value is an integer field, parsing "tab" will result in NaN
      expect(result).toBeDefined();
      expect(result?.row.name).toBe('name with');
      expect(result?.row.value).toBeNaN();
    });
  });

  describe('parseLine with different DataTypes', () => {
    it('should parse Boolean values correctly', () => {
      const booleanSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'is_active', dataType: DataType.Boolean },
          { name: 'is_verified', dataType: DataType.Boolean }
        ]
      };
      const handler = new MaterializeProtocolHandler(booleanSourceDef, 'test_view');

      // Test 't' and 'f' values
      const line1 = '1234567890\tupsert\t123\tt\tf';
      const result1 = handler.parseLine(line1);
      expect(result1?.row).toEqual({
        id: '123',
        is_active: true,
        is_verified: false
      });

      // Test 'true' value
      const line2 = '1234567890\tupsert\t123\ttrue\tfalse';
      const result2 = handler.parseLine(line2);
      expect(result2?.row).toEqual({
        id: '123',
        is_active: true,
        is_verified: false
      });
    });

    it('should parse Float values correctly', () => {
      const floatSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'price', dataType: DataType.Float },
          { name: 'rate', dataType: DataType.Float }
        ]
      };
      const handler = new MaterializeProtocolHandler(floatSourceDef, 'test_view');

      const line = '1234567890\tupsert\t123\t99.99\t0.05';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: '123',
        price: 99.99,
        rate: 0.05
      });

      // Test scientific notation
      const line2 = '1234567890\tupsert\t123\t1.23e10\t-4.56e-3';
      const result2 = handler.parseLine(line2);
      expect(result2?.row).toEqual({
        id: '123',
        price: 1.23e10,
        rate: -4.56e-3
      });
    });

    it('should parse BigInt values as strings to preserve precision', () => {
      const bigintSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'large_number', dataType: DataType.BigInt }
        ]
      };
      const handler = new MaterializeProtocolHandler(bigintSourceDef, 'test_view');

      const line = '1234567890\tupsert\t123\t9223372036854775807';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: '123',
        large_number: '9223372036854775807' // Should remain as string
      });
      expect(typeof result?.row.large_number).toBe('string');
    });

    it('should parse timestamp/date/time values as strings', () => {
      const temporalSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'created_at', dataType: DataType.Timestamp },
          { name: 'birth_date', dataType: DataType.Date },
          { name: 'start_time', dataType: DataType.Time }
        ]
      };
      const handler = new MaterializeProtocolHandler(temporalSourceDef, 'test_view');

      const line = '1234567890\tupsert\t123\t2023-01-15 14:30:00\t1990-05-20\t09:15:30';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: '123',
        created_at: '2023-01-15 14:30:00',
        birth_date: '1990-05-20',
        start_time: '09:15:30'
      });
    });

    it('should parse UUID and JSON values as strings', () => {
      const specialSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.UUID },
          { name: 'metadata', dataType: DataType.JSON }
        ]
      };
      const handler = new MaterializeProtocolHandler(specialSourceDef, 'test_view');

      const line = '1234567890\tupsert\t550e8400-e29b-41d4-a716-446655440000\t{"key":"value","num":42}';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: '550e8400-e29b-41d4-a716-446655440000',
        metadata: '{"key":"value","num":42}'
      });
    });

    it('should handle NaN for invalid numeric values', () => {
      const numericSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.String },
          { name: 'int_value', dataType: DataType.Integer },
          { name: 'float_value', dataType: DataType.Float }
        ]
      };
      const handler = new MaterializeProtocolHandler(numericSourceDef, 'test_view');

      const line = '1234567890\tupsert\t123\tnot_a_number\tinvalid_float';
      const result = handler.parseLine(line);
      expect(result?.row.id).toBe('123');
      expect(result?.row.int_value).toBeNaN();
      expect(result?.row.float_value).toBeNaN();
    });
  });

  describe('enum handling', () => {
    it('should convert enum string values to their ordinal indices', () => {
      const orderStatusEnum: EnumType = {
        name: 'order_status',
        values: ['pending', 'processing', 'shipped', 'delivered', 'cancelled']
      };

      const enumSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'status', dataType: DataType.Integer, enumType: orderStatusEnum },
          { name: 'notes', dataType: DataType.String }
        ]
      };
      const handler = new MaterializeProtocolHandler(enumSourceDef, 'test_view');

      // Test converting 'shipped' to index 2
      const line1 = '1234567890\tupsert\t123\tshipped\tOrder shipped today';
      const result1 = handler.parseLine(line1);
      expect(result1?.row).toEqual({
        id: 123,
        status: 2,  // 'shipped' is at index 2
        notes: 'Order shipped today'
      });

      // Test all enum values
      const testCases = [
        { value: 'pending', expectedIndex: 0 },
        { value: 'processing', expectedIndex: 1 },
        { value: 'shipped', expectedIndex: 2 },
        { value: 'delivered', expectedIndex: 3 },
        { value: 'cancelled', expectedIndex: 4 }
      ];

      testCases.forEach(({ value, expectedIndex }) => {
        const line = `1234567890\tupsert\t456\t${value}\tTest note`;
        const result = handler.parseLine(line);
        expect(result?.row.status).toBe(expectedIndex);
      });
    });

    it('should handle NULL enum values', () => {
      const priorityEnum: EnumType = {
        name: 'priority',
        values: ['low', 'medium', 'high', 'critical']
      };

      const enumSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'priority', dataType: DataType.Integer, enumType: priorityEnum }
        ]
      };
      const handler = new MaterializeProtocolHandler(enumSourceDef, 'test_view');

      const line = '1234567890\tupsert\t789\t\\N';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: 789,
        priority: null
      });
    });

    it('should throw error for invalid enum values', () => {
      const statusEnum: EnumType = {
        name: 'status',
        values: ['active', 'inactive', 'suspended']
      };

      const enumSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'status', dataType: DataType.Integer, enumType: statusEnum }
        ]
      };
      const handler = new MaterializeProtocolHandler(enumSourceDef, 'test_view');

      const line = '1234567890\tupsert\t123\tinvalid_status';
      expect(() => handler.parseLine(line)).toThrow(
        "Invalid enum value 'invalid_status' for enum type 'status'"
      );
    });

    it('should handle multiple enum fields', () => {
      const statusEnum: EnumType = {
        name: 'order_status',
        values: ['pending', 'shipped', 'delivered']
      };
      const priorityEnum: EnumType = {
        name: 'priority',
        values: ['low', 'medium', 'high']
      };

      const enumSourceDef: SourceDefinition = {
        name: 'test',
        primaryKeyField: 'id',
        fields: [
          { name: 'id', dataType: DataType.Integer },
          { name: 'status', dataType: DataType.Integer, enumType: statusEnum },
          { name: 'priority', dataType: DataType.Integer, enumType: priorityEnum },
          { name: 'amount', dataType: DataType.Float }
        ]
      };
      const handler = new MaterializeProtocolHandler(enumSourceDef, 'test_view');

      const line = '1234567890\tupsert\t999\tdelivered\thigh\t123.45';
      const result = handler.parseLine(line);
      expect(result?.row).toEqual({
        id: 999,
        status: 2,      // 'delivered' is at index 2
        priority: 2,    // 'high' is at index 2
        amount: 123.45
      });
    });
  });
});