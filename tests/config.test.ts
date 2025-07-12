import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDatabaseConfig, loadSchema, ConfigError } from '../src/config.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('loadDatabaseConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should load valid database configuration', () => {
    process.env.SOURCE_HOST = 'localhost';
    process.env.SOURCE_PORT = '6875';
    process.env.SOURCE_USER = 'materialize';
    process.env.SOURCE_PASSWORD = 'password';
    process.env.SOURCE_DB = 'materialize';

    const config = loadDatabaseConfig();

    expect(config).toEqual({
      host: 'localhost',
      port: 6875,
      user: 'materialize',
      password: 'password',
      database: 'materialize',
    });
  });

  it('should throw ConfigError for missing SOURCE_HOST', () => {
    delete process.env.SOURCE_HOST; // Explicitly remove SOURCE_HOST
    process.env.SOURCE_PORT = '6875';
    process.env.SOURCE_USER = 'materialize';
    process.env.SOURCE_PASSWORD = 'password';
    process.env.SOURCE_DB = 'materialize';

    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
  });

  it('should throw ConfigError for invalid port', () => {
    process.env.SOURCE_HOST = 'localhost';
    process.env.SOURCE_PORT = 'invalid';
    process.env.SOURCE_USER = 'materialize';
    process.env.SOURCE_PASSWORD = 'password';
    process.env.SOURCE_DB = 'materialize';

    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
  });
});

describe('loadSchema', () => {
  const testSchemaDir = join(process.cwd(), 'test-schemas');

  beforeEach(() => {
    mkdirSync(testSchemaDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testSchemaDir, { recursive: true, force: true });
  });

  it('should load valid schema file', () => {
    const schemaContent = `views:
  TestType:
    view: test_view
    primary_key: id
    columns:
      id: integer
      name: text
      value: double precision
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.yaml'), schemaContent);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      const schema = loadSchema();
      
      expect(schema.typeDefs).toContain('type TestType');
      expect(schema.typeDefs).toContain('type Query');
      expect(schema.typeDefs).toContain('type Subscription');
      expect(schema.primaryKeyField).toBe('id');
      expect(schema.viewName).toBe('TestType');
      expect(schema.fields).toHaveLength(3);
      expect(schema.fields[0]).toEqual({
        name: 'id',
        type: 'Int',
        nullable: false,
        isPrimaryKey: true,
      });
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });

  it('should throw ConfigError for missing schema file', () => {
    expect(() => loadSchema()).toThrow(ConfigError);
    expect(() => loadSchema()).toThrow('Schema file not found');
  });

  it('should throw ConfigError for schema without primary key', () => {
    const invalidSchema = `views:
  TestType:
    view: test_view
    columns:
      name: text
      value: double precision
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.yaml'), invalidSchema);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Schema must contain a primary_key attribute');
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });

  it('should throw ConfigError for schema with multiple views', () => {
    const multiViewSchema = `views:
  TestType1:
    view: test_view1
    primary_key: id
    columns:
      id: integer
      name: text
  TestType2:
    view: test_view2
    primary_key: id
    columns:
      id: integer
      value: double precision
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.yaml'), multiViewSchema);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Only one view definition is supported in the current version');
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });

  it('should throw ConfigError for invalid YAML syntax', () => {
    const invalidYaml = `views:
  TestType:
    view: test_view
    primary_key: id
    columns:
      id: integer
      name: text
    - invalid yaml syntax`;

    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.yaml'), invalidYaml);

    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
    } finally {
      process.cwd = originalCwd;
    }
  });

  it('should throw ConfigError for empty YAML file', () => {
    const emptyYaml = '';

    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.yaml'), emptyYaml);

    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Invalid YAML schema format');
    } finally {
      process.cwd = originalCwd;
    }
  });
});