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

    it('should return TEXT OID for unknown types', () => {
      expect(getPostgresType('unknown_type')).toBe(pgTypes.builtins.TEXT);
      expect(getPostgresType('custom_type')).toBe(pgTypes.builtins.TEXT);
    });

    it('should be case-sensitive', () => {
      // These should return TEXT OID since they don't match exactly
      expect(getPostgresType('BOOLEAN')).toBe(pgTypes.builtins.TEXT);
      expect(getPostgresType('Integer')).toBe(pgTypes.builtins.TEXT);
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

    it('should return String for unknown types', () => {
      expect(getGraphQLType('unknown_type')).toBe('String');
      expect(getGraphQLType('custom_type')).toBe('String');
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