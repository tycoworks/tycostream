import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import * as yaml from 'js-yaml';
import { loadGraphQLSchemaFromYaml } from './schema';

// Mock fs module
vi.mock('fs', () => ({
  readFileSync: vi.fn()
}));

// Mock js-yaml
vi.mock('js-yaml', () => ({
  load: vi.fn()
}));

// Mock pg-types
vi.mock('pg-types', () => ({
  default: {
    builtins: {
      BOOL: 16,
      INT8: 20,
      INT2: 21,
      INT4: 23,
      TEXT: 25,
      FLOAT4: 700,
      FLOAT8: 701,
      NUMERIC: 1700,
      UUID: 2950,
      TIMESTAMP: 1114,
      TIMESTAMPTZ: 1184,
      DATE: 1082,
      TIME: 1083,
      JSON: 114,
      JSONB: 3802
    }
  }
}));

// Mock pg-type-names
vi.mock('pg-type-names', () => ({
  default: {
    oids: {
      'boolean': 16,
      'bigint': 20,
      'smallint': 21,
      'integer': 23,
      'text': 25,
      'real': 700,
      'double precision': 701,
      'numeric': 1700,
      'uuid': 2950,
      'timestamp': 1114,
      'timestamptz': 1184,
      'date': 1082,
      'time': 1083,
      'json': 114,
      'jsonb': 3802,
      'varchar': 25
    }
  }
}));

describe('loadGraphQLSchemaFromYaml', () => {
  const mockReadFileSync = vi.mocked(readFileSync);
  const mockLoad = vi.mocked(yaml.load);

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    delete process.env.LOG_LEVEL;
  });

  describe('successful loading', () => {
    it('should load a simple schema with one source', () => {
      const yamlContent = `
sources:
  users:
    primary_key: id
    columns:
      id: uuid
      name: text
      created_at: timestamp
`;
      
      mockReadFileSync.mockReturnValue(yamlContent);
      mockLoad.mockReturnValue({
        sources: {
          users: {
            primary_key: 'id',
            columns: {
              id: 'uuid',
              name: 'text',
              created_at: 'timestamp'
            }
          }
        }
      });

      const schema = loadGraphQLSchemaFromYaml('/config');

      expect(mockReadFileSync).toHaveBeenCalledWith('/config/schema.yaml', 'utf-8');
      expect(schema.sources.size).toBe(1);
      
      const userSource = schema.sources.get('users');
      expect(userSource).toBeDefined();
      expect(userSource?.primaryKeyField).toBe('id');
      expect(userSource?.fields).toHaveLength(3);
      
      // Check field mapping
      const idField = userSource?.fields.find(f => f.name === 'id');
      expect(idField).toEqual({
        name: 'id',
        type: 'ID',
        nullable: false,
        isPrimaryKey: true
      });

      // Check generated typeDefs
      expect(schema.typeDefs).toContain('type users {');
      expect(schema.typeDefs).toContain('id: ID!');
      expect(schema.typeDefs).toContain('name: String');
      expect(schema.typeDefs).toContain('created_at: String');
      expect(schema.typeDefs).toContain('type Subscription {');
      expect(schema.typeDefs).toContain('users: users!');
    });

    it('should handle multiple sources', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          users: {
            primary_key: 'id',
            columns: { id: 'integer', name: 'text' }
          },
          products: {
            primary_key: 'sku',
            columns: { sku: 'text', price: 'numeric', active: 'boolean' }
          }
        }
      });

      const schema = loadGraphQLSchemaFromYaml('/config');

      expect(schema.sources.size).toBe(2);
      expect(schema.sources.has('users')).toBe(true);
      expect(schema.sources.has('products')).toBe(true);
      
      // Check subscription includes both
      expect(schema.typeDefs).toContain('users: users!');
      expect(schema.typeDefs).toContain('products: products!');
    });

    it('should map all supported PostgreSQL types', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          test_types: {
            primary_key: 'id',
            columns: {
              id: 'uuid',
              bool_col: 'boolean',
              int2_col: 'smallint',
              int4_col: 'integer',
              int8_col: 'bigint',
              float4_col: 'real',
              float8_col: 'double precision',
              numeric_col: 'numeric',
              text_col: 'text',
              varchar_col: 'varchar',
              timestamp_col: 'timestamp',
              timestamptz_col: 'timestamptz',
              date_col: 'date',
              time_col: 'time',
              json_col: 'json',
              jsonb_col: 'jsonb'
            }
          }
        }
      });

      const schema = loadGraphQLSchemaFromYaml('/config');
      const testSource = schema.sources.get('test_types');
      const fields = testSource?.fields || [];

      // Check type mappings
      expect(fields.find(f => f.name === 'id')?.type).toBe('ID');
      expect(fields.find(f => f.name === 'bool_col')?.type).toBe('Boolean');
      expect(fields.find(f => f.name === 'int2_col')?.type).toBe('Int');
      expect(fields.find(f => f.name === 'int4_col')?.type).toBe('Int');
      expect(fields.find(f => f.name === 'int8_col')?.type).toBe('Float'); // bigint -> Float
      expect(fields.find(f => f.name === 'float4_col')?.type).toBe('Float');
      expect(fields.find(f => f.name === 'float8_col')?.type).toBe('Float');
      expect(fields.find(f => f.name === 'numeric_col')?.type).toBe('Float');
      expect(fields.find(f => f.name === 'text_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'varchar_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'timestamp_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'timestamptz_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'date_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'time_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'json_col')?.type).toBe('String');
      expect(fields.find(f => f.name === 'jsonb_col')?.type).toBe('String');
    });

    it('should handle debug logging when LOG_LEVEL is debug', () => {
      process.env.LOG_LEVEL = 'debug';
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          test: {
            primary_key: 'id',
            columns: { id: 'integer', name: 'text' }
          }
        }
      });

      loadGraphQLSchemaFromYaml('/config');

      expect(consoleSpy).toHaveBeenCalledWith(
        'Generated GraphQL schema from YAML:',
        expect.objectContaining({
          sourceName: 'test',
          primaryKeyField: 'id',
          fieldsCount: 2
        })
      );

      consoleSpy.mockRestore();
    });
  });

  describe('error handling', () => {
    it('should throw error when schema file not found', () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockReadFileSync.mockImplementation(() => { throw error; });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        'Schema file not found at /config/schema.yaml. Create a schema.yaml file in the config directory.'
      );
    });

    it('should rethrow other file system errors', () => {
      const error = new Error('Permission denied');
      mockReadFileSync.mockImplementation(() => { throw error; });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow('Permission denied');
    });

    it('should throw error for invalid YAML', () => {
      mockReadFileSync.mockReturnValue('valid yaml');
      mockLoad.mockReturnValue(null);

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow('Invalid YAML schema format');
    });

    it('should throw error when sources section is missing', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({ other: 'data' });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        'YAML schema must contain a "sources" section'
      );
    });

    it('should throw error when no sources are defined', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({ sources: {} });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        'YAML schema must contain at least one source definition'
      );
    });

    it('should throw error when primary_key is missing', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          users: {
            columns: { id: 'integer' }
          }
        }
      } as any);

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        "Source 'users' must contain a primary_key attribute"
      );
    });

    it('should throw error when primary key field not in columns', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          users: {
            primary_key: 'missing_id',
            columns: { id: 'integer' }
          }
        }
      });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        "Primary key field 'missing_id' not found in columns for source 'users'"
      );
    });

    it('should throw error for unsupported primary key types', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          users: {
            primary_key: 'data',
            columns: { data: 'json' }
          }
        }
      });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        "Primary key type 'json' is not supported for source 'users'. Supported types: integer, bigint, text, varchar, uuid"
      );
    });

    it('should throw error for unknown PostgreSQL type', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          users: {
            primary_key: 'id',
            columns: { id: 'integer', data: 'unknown_type' }
          }
        }
      });

      expect(() => loadGraphQLSchemaFromYaml('/config')).toThrow(
        'Unknown PostgreSQL type: unknown_type'
      );
    });

    // Note: Testing unmapped types requires runtime modification of mocked modules
    // which is complex. The actual behavior is tested in integration tests.
  });

  describe('edge cases', () => {
    it('should handle empty columns', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          empty: {
            primary_key: 'id',
            columns: { id: 'integer' } // Only primary key
          }
        }
      });

      const schema = loadGraphQLSchemaFromYaml('/config');
      const emptySource = schema.sources.get('empty');
      
      expect(emptySource?.fields).toHaveLength(1);
      expect(emptySource?.fields[0]).toEqual({
        name: 'id',
        type: 'Int',
        nullable: false,
        isPrimaryKey: true
      });
    });

    it('should handle source names with special characters', () => {
      mockReadFileSync.mockReturnValue('');
      mockLoad.mockReturnValue({
        sources: {
          'user_profiles_v2': {
            primary_key: 'id',
            columns: { id: 'uuid' }
          }
        }
      });

      const schema = loadGraphQLSchemaFromYaml('/config');
      expect(schema.sources.has('user_profiles_v2')).toBe(true);
      expect(schema.typeDefs).toContain('type user_profiles_v2 {');
    });
  });
});