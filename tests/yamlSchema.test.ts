/**
 * Test YAML schema loading and GraphQL/database source name separation
 */

import { describe, it, expect } from 'vitest';
import { loadGraphQLSchemaFromYaml } from '../src/core/schema.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('YAML Schema Processing', () => {
  it('should separate GraphQL type name from database source name', () => {

    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `sources:
  CustomTypeName:
    primary_key: id
    columns:
      id: integer
      name: text`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadGraphQLSchemaFromYaml(configDir);
    const source = schema.sources.get('CustomTypeName')!;
    
    // GraphQL type name should be the YAML key
    expect(source.sourceName).toBe('CustomTypeName');
    
    
    // Generated GraphQL schema should use the GraphQL type name
    expect(schema.typeDefs).toContain('type CustomTypeName');
    expect(schema.typeDefs).toContain('CustomTypeName: CustomTypeName!');
  });

  it('should handle case where GraphQL type name matches database source name', () => {

    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-same-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `sources:
  live_pnl:
    primary_key: id
    columns:
      id: integer
      value: double precision`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadGraphQLSchemaFromYaml(configDir);
    const source = schema.sources.get('live_pnl')!;
    
    // Source name should be live_pnl
    expect(source.sourceName).toBe('live_pnl');
  });

  it('should validate that GraphQL and database source names are used correctly', () => {
    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-validation-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `sources:
  MyGraphQLType:
    primary_key: id
    columns:
      id: integer
      name: text`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadGraphQLSchemaFromYaml(configDir);
    const source = schema.sources.get('MyGraphQLType')!;
    
    // Should use GraphQL type name in schema
    expect(schema.typeDefs).toContain('type MyGraphQLType');
    expect(schema.typeDefs).toContain('MyGraphQLType: MyGraphQLType!');
    
    // Source name should be MyGraphQLType
    expect(source.sourceName).toBe('MyGraphQLType');
  });

  it('should map PostgreSQL types to GraphQL types correctly', () => {
    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-typemap-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file with various PostgreSQL types
    const yamlContent = `sources:
  TypeMappingTest:
    primary_key: id
    columns:
      id: integer
      is_active: boolean
      count: bigint
      small_num: smallint
      name: text
      price: numeric
      rate: real
      precise_rate: double precision
      user_id: uuid
      created_at: timestamp without time zone
      updated_at: timestamp with time zone
      birth_date: date
      start_time: time without time zone
      metadata: json
      settings: jsonb`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadGraphQLSchemaFromYaml(configDir);
    const source = schema.sources.get('TypeMappingTest')!;
    
    // Verify type mappings
    const typeMap = new Map(source.fields.map(f => [f.name, f.type]));
    
    expect(typeMap.get('id')).toBe('Int');
    expect(typeMap.get('is_active')).toBe('Boolean');
    expect(typeMap.get('count')).toBe('Float'); // bigint maps to Float
    expect(typeMap.get('small_num')).toBe('Int');
    expect(typeMap.get('name')).toBe('String');
    expect(typeMap.get('price')).toBe('Float');
    expect(typeMap.get('rate')).toBe('Float');
    expect(typeMap.get('precise_rate')).toBe('Float');
    expect(typeMap.get('user_id')).toBe('ID');
    expect(typeMap.get('created_at')).toBe('String');
    expect(typeMap.get('updated_at')).toBe('String');
    expect(typeMap.get('birth_date')).toBe('String');
    expect(typeMap.get('start_time')).toBe('String');
    expect(typeMap.get('metadata')).toBe('String');
    expect(typeMap.get('settings')).toBe('String');
    
    // Verify primary key
    expect(source.primaryKeyField).toBe('id');
    const idField = source.fields.find(f => f.name === 'id');
    expect(idField?.isPrimaryKey).toBe(true);
    expect(idField?.nullable).toBe(false);
    
    // Verify other fields are nullable
    const nameField = source.fields.find(f => f.name === 'name');
    expect(nameField?.nullable).toBe(true);
  });

  it('should validate primary key is present', () => {
    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-no-pk-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file without primary_key
    const yamlContent = `sources:
  NoPrimaryKey:
    columns:
      id: integer
      name: text`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Should throw error
    expect(() => loadGraphQLSchemaFromYaml(configDir)).toThrow('Source \'NoPrimaryKey\' must contain a primary_key attribute');
  });

  it('should validate primary key exists in columns', () => {
    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-invalid-pk-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file with non-existent primary key
    const yamlContent = `sources:
  InvalidPrimaryKey:
    primary_key: nonexistent_field
    columns:
      id: integer
      name: text`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Should throw error
    expect(() => loadGraphQLSchemaFromYaml(configDir)).toThrow("Primary key field 'nonexistent_field' not found in columns");
  });
});