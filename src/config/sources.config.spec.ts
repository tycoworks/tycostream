import * as fs from 'fs';
import * as yaml from 'js-yaml';
import sourcesConfig from './sources.config';

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
            id: 'integer',
            instrument_id: 'integer',
            quantity: 'integer',
            price: 'numeric',
            executed_at: 'timestamp without time zone',
          },
        },
        live_pnl: {
          primary_key: 'instrument_id',
          columns: {
            instrument_id: 'integer',
            symbol: 'text',
            net_position: 'bigint',
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

  it('should handle missing schema file gracefully', () => {
    const error = new Error('ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    (fs.readFileSync as jest.Mock).mockImplementation(() => {
      throw error;
    });

    const sources = sourcesConfig();
    
    expect(sources).toBeInstanceOf(Map);
    expect(sources.size).toBe(0);
  });

  it('should throw on invalid primary key', () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(mockYamlContent);
    (yaml.load as jest.Mock).mockReturnValue({
      sources: {
        invalid: {
          primary_key: 'missing_field',
          columns: {
            id: 'integer',
          },
        },
      },
    });

    expect(() => sourcesConfig()).toThrow(
      "Primary key 'missing_field' not found in columns for source 'invalid'"
    );
  });
});