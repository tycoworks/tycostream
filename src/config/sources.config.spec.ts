import * as fs from 'fs';
import * as yaml from 'js-yaml';
import sourcesConfig from './sources.config';
import { DataType } from '../common/types';

jest.mock('fs');
jest.mock('js-yaml');

describe('SourcesConfig', () => {
  const mockYamlContent = `
sources:
  trades:
    primary_key: id
    columns:
      id: integer
      instrument_id: integer
      quantity: integer
      price: numeric
      executed_at: timestamp without time zone
  live_pnl:
    primary_key: instrument_id
    columns:
      instrument_id: integer
      symbol: text
      net_position: bigint
`;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should load source definitions from YAML', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(mockYamlContent);
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {
        trades: {
          primary_key: 'id',
          columns: {
            id: 'Integer',
            instrument_id: 'Integer',
            quantity: 'Integer',
            price: 'Float',
            executed_at: 'Timestamp',
          },
        },
        live_pnl: {
          primary_key: 'instrument_id',
          columns: {
            instrument_id: 'Integer',
            symbol: 'String',
            net_position: 'BigInt',
          },
        },
      },
    });

    const sources = sourcesConfig();
    
    expect(sources).toBeInstanceOf(Map);
    expect(sources.size).toBe(2);
    expect(sources.has('trades')).toBe(true);
    expect(sources.has('live_pnl')).toBe(true);
    
    const trades = sources.get('trades');
    expect(trades?.primaryKeyField).toBe('id');
    expect(trades?.fields).toHaveLength(5);
  });

  it('should throw error when schema file is missing', () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw error;
    });

    expect(() => sourcesConfig()).toThrow('Schema file not found');
  });

  it('should throw error when no sources are defined', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('sources: {}');
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {}
    });

    expect(() => sourcesConfig()).toThrow('No source definitions found in schema file');
  });

  it('should throw on invalid primary key', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(mockYamlContent);
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {
        invalid: {
          primary_key: 'missing_field',
          columns: {
            id: 'Integer',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Primary key 'missing_field' not found in columns for source 'invalid'"
    );
  });

  it('should throw error for invalid DataType names', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('sources with invalid type');
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {
        test: {
          primary_key: 'id',
          columns: {
            id: 'NotAType',
            value: 'Integer',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Invalid type 'NotAType' for column 'id' in source 'test': Unknown type in configuration: NotAType"
    );
  });

  it('should throw error for case-sensitive type names', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('sources with wrong case');
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {
        test: {
          primary_key: 'id',
          columns: {
            id: 'integer',  // lowercase, should be 'Integer'
            name: 'string',  // lowercase, should be 'String'
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Invalid type 'integer' for column 'id' in source 'test': Unknown type in configuration: integer"
    );
  });

  it('should parse enum definitions and attach to fields', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('test');
    (yaml.load as jest.Mock).mockReturnValue({
      enums: {
        trade_side: ['buy', 'sell'],
        order_status: ['pending', 'filled', 'cancelled']
      },
      sources: {
        trades: {
          primary_key: 'id',
          columns: {
            id: 'Integer',
            side: 'trade_side',      // Direct reference to enum
            status: 'order_status',   // Direct reference to enum
            notes: 'String',          // Regular string field
          }
        }
      }
    });

    const sources = sourcesConfig();
    const trades = sources.get('trades');

    expect(trades).toBeDefined();
    expect(trades?.fields).toHaveLength(4);

    // Check side field has trade_side enum metadata
    const sideField = trades?.fields.find(f => f.name === 'side');
    expect(sideField?.dataType).toBe(DataType.String);
    expect(sideField?.enumType).toEqual({
      name: 'trade_side',
      values: ['buy', 'sell']
    });

    // Check status field has order_status enum metadata
    const statusField = trades?.fields.find(f => f.name === 'status');
    expect(statusField?.dataType).toBe(DataType.String);
    expect(statusField?.enumType).toEqual({
      name: 'order_status',
      values: ['pending', 'filled', 'cancelled']
    });

    // Check notes field is regular string without enum
    const notesField = trades?.fields.find(f => f.name === 'notes');
    expect(notesField?.dataType).toBe(DataType.String);
    expect(notesField?.enumType).toBeUndefined();
  });

  it('should validate enum definitions', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue('test');
    (yaml.load as jest.Mock).mockReturnValue({
      enums: {
        empty_enum: []  // Invalid: empty array
      },
      sources: {
        test: {
          primary_key: 'id',
          columns: {
            id: 'Integer'
          }
        }
      }
    });

    expect(() => sourcesConfig()).toThrow("Enum 'empty_enum' must have at least one value");
  });
});