import * as fs from 'fs';
import { PostgresType } from '../common/types.js';
import * as yaml from 'js-yaml';
import sourcesConfig from './sources.config.js';
import type { Mock } from 'vitest';

vi.mock('fs');
vi.mock('js-yaml');

describe('SourcesConfig', () => {
  const mockYamlContent = `
sources:
  trades:
    primary_key: id
    columns:
      id: int4
      instrument_id: int4
      quantity: int4
      price: numeric
      executed_at: timestamp
  live_pnl:
    primary_key: instrument_id
    columns:
      instrument_id: int4
      symbol: text
      net_position: int8
`;

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should load source definitions from YAML', () => {
    (fs.readFileSync as Mock).mockReturnValue(mockYamlContent);
    (yaml.load as Mock).mockReturnValue({
      sources: {
        trades: {
          primary_key: 'id',
          columns: {
            id: 'int4',
            instrument_id: 'int4',
            quantity: 'int4',
            price: 'numeric',
            executed_at: 'timestamp',
          },
        },
        live_pnl: {
          primary_key: 'instrument_id',
          columns: {
            instrument_id: 'int4',
            symbol: 'text',
            net_position: 'int8',
          },
        },
      },
    });

    const config = sourcesConfig();

    expect(config.sources).toBeInstanceOf(Map);
    expect(config.sources.size).toBe(2);
    expect(config.sources.has('trades')).toBe(true);
    expect(config.sources.has('live_pnl')).toBe(true);

    const trades = config.sources.get('trades');
    expect(trades?.primaryKeyField).toBe('id');
    expect(trades?.fields).toHaveLength(5);

    expect(config.enums).toBeInstanceOf(Map);
    expect(config.enums.size).toBe(0); // No enums in this test
  });

  describe('foreign keys', () => {
    const positions = {
      primary_key: 'instrument_id',
      columns: { instrument_id: 'int4', symbol: 'text', net_position: 'int8' },
    };
    const load = (trades: object) => {
      (fs.readFileSync as Mock).mockReturnValue('');
      (yaml.load as Mock).mockReturnValue({ sources: { trades, positions } });
      return sourcesConfig();
    };

    it('should give each source its foreign keys, each column with the source it references, declared before or after it', () => {
      const config = load({
        primary_key: 'id',
        columns: { id: 'int4', instrument_id: 'int4', quantity: 'int4' },
        foreign_keys: { instrument_id: 'positions' },
      });

      expect(config.sources.get('trades')?.foreignKeys).toEqual([
        {
          column: 'instrument_id',
          references: config.sources.get('positions'),
        },
      ]);
      expect(config.sources.get('positions')?.foreignKeys).toEqual([]);
    });

    it("should throw on a foreign key column the source doesn't have", () => {
      expect(() =>
        load({
          primary_key: 'id',
          columns: { id: 'int4', quantity: 'int4' },
          foreign_keys: { instrument_id: 'positions' },
        }),
      ).toThrow(
        "Foreign key 'instrument_id' not found in columns for source 'trades'",
      );
    });

    it('should throw on a foreign key that references an unknown source', () => {
      expect(() =>
        load({
          primary_key: 'id',
          columns: { id: 'int4', instrument_id: 'int4' },
          foreign_keys: { instrument_id: 'position' },
        }),
      ).toThrow(
        "Foreign key 'instrument_id' of source 'trades' references unknown source 'position'",
      );
    });
  });

  it('should throw error when schema file is missing', () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    (fs.readFileSync as Mock).mockImplementation(() => {
      throw error;
    });

    expect(() => sourcesConfig()).toThrow('Schema file not found');
  });

  it('should throw error when no sources are defined', () => {
    (fs.readFileSync as Mock).mockReturnValue('sources: {}');
    (yaml.load as Mock).mockReturnValue({
      sources: {},
    });

    expect(() => sourcesConfig()).toThrow(
      'No source definitions found in schema file',
    );
  });

  it('should throw on invalid primary key', () => {
    (fs.readFileSync as Mock).mockReturnValue(mockYamlContent);
    (yaml.load as Mock).mockReturnValue({
      sources: {
        invalid: {
          primary_key: 'missing_field',
          columns: {
            id: 'int4',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Primary key 'missing_field' not found in columns for source 'invalid'",
    );
  });

  it('should throw error for invalid type names', () => {
    (fs.readFileSync as Mock).mockReturnValue('sources with invalid type');
    (yaml.load as Mock).mockReturnValue({
      sources: {
        test: {
          primary_key: 'id',
          columns: {
            id: 'NotAType',
            value: 'int4',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Invalid type 'NotAType' for column 'id' in source 'test': Unsupported type in configuration: NotAType",
    );
  });

  // A one-column source of the given type, as schema.yaml would give it
  const loadColumnOfType = (typeName: string) => {
    (fs.readFileSync as Mock).mockReturnValue('one column');
    (yaml.load as Mock).mockReturnValue({
      sources: { test: { primary_key: 'id', columns: { id: typeName } } },
    });
    return sourcesConfig().sources.get('test')!.fields[0];
  };

  it.each([
    ['int4', PostgresType.Int4],
    ['int8', PostgresType.Int8],
    ['numeric', PostgresType.Numeric],
    ['varchar', PostgresType.Varchar],
    ['timestamptz', PostgresType.Timestamptz],
    ['jsonb', PostgresType.Jsonb],
  ])(
    "should read a column's type by its name in Postgres's catalog, such as %s",
    (typeName, type) => {
      expect(loadColumnOfType(typeName)).toEqual({ name: 'id', type });
    },
  );

  it.each([
    // The SQL name, rather than the catalog's
    'integer',
    // tycostream's old name
    'Integer',
    // Postgres types tycostream doesn't serve, including arrays for now
    'money',
    '_int4',
  ])("should reject '%s', listing the types it serves", (typeName) => {
    expect(() => loadColumnOfType(typeName)).toThrow(
      `Unsupported type in configuration: ${typeName}. Supported types are: int2, int4,`,
    );
  });

  it('should parse enum definitions and attach to fields', () => {
    (fs.readFileSync as Mock).mockReturnValue('test');
    (yaml.load as Mock).mockReturnValue({
      enums: {
        trade_side: ['buy', 'sell'],
        order_status: ['pending', 'filled', 'cancelled'],
      },
      sources: {
        trades: {
          primary_key: 'id',
          columns: {
            id: 'int4',
            side: 'trade_side', // Direct reference to enum
            status: 'order_status', // Direct reference to enum
            notes: 'text', // Regular text field
          },
        },
      },
    });

    const config = sourcesConfig();
    const trades = config.sources.get('trades');

    expect(trades).toBeDefined();
    expect(trades?.fields).toHaveLength(4);

    // Check that enums were parsed
    expect(config.enums.size).toBe(2);
    expect(config.enums.has('trade_side')).toBe(true);
    expect(config.enums.has('order_status')).toBe(true);

    // Check side field has trade_side enum metadata
    const sideField = trades?.fields.find((f) => f.name === 'side');
    expect(sideField?.type).toBe(PostgresType.Text); // Enums are strings at runtime
    expect(sideField?.enumType).toEqual({
      name: 'trade_side',
      values: ['buy', 'sell'],
    });

    // Check status field has order_status enum metadata
    const statusField = trades?.fields.find((f) => f.name === 'status');
    expect(statusField?.type).toBe(PostgresType.Text); // Enums are strings at runtime
    expect(statusField?.enumType).toEqual({
      name: 'order_status',
      values: ['pending', 'filled', 'cancelled'],
    });

    // Check notes field is regular string without enum
    const notesField = trades?.fields.find((f) => f.name === 'notes');
    expect(notesField?.type).toBe(PostgresType.Text);
    expect(notesField?.enumType).toBeUndefined();
  });

  it('should validate enum definitions', () => {
    (fs.readFileSync as Mock).mockReturnValue('test');
    (yaml.load as Mock).mockReturnValue({
      enums: {
        empty_enum: [], // Invalid: empty array
      },
      sources: {
        test: {
          primary_key: 'id',
          columns: {
            id: 'int4',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Enum 'empty_enum' must have at least one value",
    );
  });
});
