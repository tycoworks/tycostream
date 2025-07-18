import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadDatabaseConfig, loadSchema, ConfigError } from '../src/core/config.js';
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
    const schemaContent = `sources:
  TestType:
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
      const testSource = schema.sources.get('TestType')!;
      
      expect(schema.typeDefs).toContain('type TestType');
      expect(schema.typeDefs).toContain('type Subscription');
      expect(schema.typeDefs).toContain('type Query');
      expect(testSource.primaryKeyField).toBe('id');
      expect(testSource.sourceName).toBe('TestType');
      expect(testSource.fields).toHaveLength(3);
      expect(testSource.fields[0]).toEqual({
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
    const invalidSchema = `sources:
  TestType:
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
      expect(() => loadSchema()).toThrow('must contain a primary_key attribute');
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });


  it('should throw ConfigError for invalid YAML syntax', () => {
    const invalidYaml = `sources:
  TestType:
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