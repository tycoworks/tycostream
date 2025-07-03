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
    const schemaContent = `
type TestType {
  id: ID!
  name: String!
  value: Float!
}

type Subscription {
  test_view: TestType!
}
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.sdl'), schemaContent);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      const schema = loadSchema();
      
      expect(schema.typeDefs).toContain('type TestType');
      expect(schema.primaryKeyField).toBe('id');
      expect(schema.viewName).toBe('TestType');
      expect(schema.fields).toHaveLength(3);
      expect(schema.fields[0]).toEqual({
        name: 'id',
        type: 'ID',
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

  it('should throw ConfigError for schema without ID field', () => {
    const invalidSchema = `
type TestType {
  name: String!
  value: Float!
}

type Subscription {
  test_view: TestType!
}
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.sdl'), invalidSchema);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Schema must contain exactly one field of type ID!');
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });

  it('should throw ConfigError for schema with multiple data types', () => {
    const multiTypeSchema = `
type TestType1 {
  id: ID!
  name: String!
}

type TestType2 {
  id: ID!
  value: Float!
}

type Subscription {
  test_view: TestType1!
}
`;

    // Create schema file in test directory structure
    const testConfigDir = join(testSchemaDir, 'config');
    mkdirSync(testConfigDir, { recursive: true });
    writeFileSync(join(testConfigDir, 'schema.sdl'), multiTypeSchema);

    // Temporarily override process.cwd() for this test
    const originalCwd = process.cwd;
    process.cwd = () => testSchemaDir;

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Schema must contain exactly one data type definition (found 2)');
    } finally {
      // Restore original cwd
      process.cwd = originalCwd;
    }
  });
});