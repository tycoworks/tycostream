/**
 * Test YAML schema loading and GraphQL/database view name separation
 */

import { describe, it, expect } from 'vitest';
import { loadSchemaFromYaml } from '../shared/schema.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('YAML Schema Processing', () => {
  it('should separate GraphQL type name from database view name', () => {

    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `views:
  CustomTypeName:
    view: actual_database_view
    columns:
      id: ID!
      name: String!`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadSchemaFromYaml(configDir);
    
    // GraphQL type name should be the YAML key
    expect(schema.viewName).toBe('CustomTypeName');
    
    // Database view name should be the 'view' field value
    expect(schema.databaseViewName).toBe('actual_database_view');
    
    // Generated GraphQL schema should use the GraphQL type name
    expect(schema.typeDefs).toContain('type CustomTypeName');
    expect(schema.typeDefs).toContain('CustomTypeName: [CustomTypeName!]!');
  });

  it('should handle case where GraphQL type name matches database view name', () => {

    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-same-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `views:
  live_pnl:
    view: live_pnl
    columns:
      id: ID!
      value: Float`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadSchemaFromYaml(configDir);
    
    // Both should be the same
    expect(schema.viewName).toBe('live_pnl');
    expect(schema.databaseViewName).toBe('live_pnl');
  });

  it('should validate that GraphQL and database view names are used correctly', () => {
    // Create temporary directory for test
    const testDir = join(tmpdir(), 'tycostream-yaml-test-validation-' + Date.now());
    const configDir = join(testDir, 'config');
    mkdirSync(configDir, { recursive: true });
    
    // Write test YAML file
    const yamlContent = `views:
  MyGraphQLType:
    view: my_db_view
    columns:
      id: ID!
      name: String`;
    writeFileSync(join(configDir, 'schema.yaml'), yamlContent);

    // Load schema
    const schema = loadSchemaFromYaml(configDir);
    
    // Should use GraphQL type name in schema
    expect(schema.typeDefs).toContain('type MyGraphQLType');
    expect(schema.typeDefs).toContain('MyGraphQLType: [MyGraphQLType!]!');
    expect(schema.typeDefs).toContain('MyGraphQLType: MyGraphQLType!');
    
    // Should NOT contain database view name in GraphQL schema
    expect(schema.typeDefs).not.toContain('my_db_view');
    
    // But should have correct database view name in schema object
    expect(schema.databaseViewName).toBe('my_db_view');
    expect(schema.viewName).toBe('MyGraphQLType');
  });
});