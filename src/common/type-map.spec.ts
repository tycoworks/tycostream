import { getPostgresType, getGraphQLType, TYPE_MAP } from './type-map';
import * as pgTypes from 'pg-types';

describe('type-map', () => {
  describe('getPostgresType', () => {
    it('should return correct OID for known type names', () => {
      // Test exact case matching
      expect(getPostgresType('boolean')).toBe(pgTypes.builtins.BOOL);
      expect(getPostgresType('integer')).toBe(pgTypes.builtins.INT4);
      expect(getPostgresType('bigint')).toBe(pgTypes.builtins.INT8);
      expect(getPostgresType('text')).toBe(pgTypes.builtins.TEXT);
      expect(getPostgresType('timestamp without time zone')).toBe(pgTypes.builtins.TIMESTAMP);
      expect(getPostgresType('jsonb')).toBe(pgTypes.builtins.JSONB);
    });

    it('should throw error for unknown type names', () => {
      expect(() => getPostgresType('unknown_type')).toThrow();
      expect(() => getPostgresType('custom_type')).toThrow();
    });

    it('should throw error for unsupported PostgreSQL types', () => {
      // Types that exist in PostgreSQL but we don't support
      expect(() => getPostgresType('point')).toThrow();
      expect(() => getPostgresType('polygon')).toThrow();
      expect(() => getPostgresType('inet')).toThrow();
      expect(() => getPostgresType('cidr')).toThrow();
      expect(() => getPostgresType('money')).toThrow();
      expect(() => getPostgresType('bytea')).toThrow();
      expect(() => getPostgresType('xml')).toThrow();
      expect(() => getPostgresType('tsvector')).toThrow();
      
      // Array types - common but not yet supported
      expect(() => getPostgresType('integer[]')).toThrow();
      expect(() => getPostgresType('text[]')).toThrow();
      expect(() => getPostgresType('uuid[]')).toThrow();
    });

    it('should be case-sensitive and throw for incorrect case', () => {
      // These should throw since they don't match exactly
      expect(() => getPostgresType('BOOLEAN')).toThrow();
      expect(() => getPostgresType('Integer')).toThrow();
    });
  });

  describe('getGraphQLType', () => {
    it('should return correct GraphQL type names', () => {
      expect(getGraphQLType('boolean')).toBe('Boolean');
      expect(getGraphQLType('integer')).toBe('Int');
      expect(getGraphQLType('bigint')).toBe('String'); // Preserves precision
      expect(getGraphQLType('numeric')).toBe('Float');
      expect(getGraphQLType('text')).toBe('String');
      expect(getGraphQLType('uuid')).toBe('ID');
      expect(getGraphQLType('timestamp without time zone')).toBe('String');
      expect(getGraphQLType('jsonb')).toBe('String');
    });

    it('should throw error for unknown types', () => {
      expect(() => getGraphQLType('unknown_type')).toThrow();
      expect(() => getGraphQLType('custom_type')).toThrow();
    });
    
    it('should throw error for unsupported types that exist in PostgreSQL', () => {
      expect(() => getGraphQLType('point')).toThrow();
      expect(() => getGraphQLType('money')).toThrow();
    });
  });

  describe('TYPE_MAP', () => {
    it('should map all PostgreSQL types to GraphQL scalar types', () => {
      // Verify all entries are valid GraphQL scalar types
      for (const [oid, graphqlType] of Object.entries(TYPE_MAP)) {
        expect(graphqlType).toBeDefined();
        expect(graphqlType.name).toBeDefined();
        expect(typeof graphqlType.name).toBe('string');
      }
    });

    it('should include all expected type mappings', () => {
      expect(TYPE_MAP[pgTypes.builtins.BOOL].name).toBe('Boolean');
      expect(TYPE_MAP[pgTypes.builtins.INT2].name).toBe('Int');
      expect(TYPE_MAP[pgTypes.builtins.INT4].name).toBe('Int');
      expect(TYPE_MAP[pgTypes.builtins.INT8].name).toBe('String');
      expect(TYPE_MAP[pgTypes.builtins.FLOAT4].name).toBe('Float');
      expect(TYPE_MAP[pgTypes.builtins.FLOAT8].name).toBe('Float');
      expect(TYPE_MAP[pgTypes.builtins.TEXT].name).toBe('String');
      expect(TYPE_MAP[pgTypes.builtins.UUID].name).toBe('ID');
    });
  });
});