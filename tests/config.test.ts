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
    process.env.VIEW_NAME = 'test_view';

    const config = loadDatabaseConfig();

    expect(config).toEqual({
      host: 'localhost',
      port: 6875,
      user: 'materialize',
      password: 'password',
      database: 'materialize',
      viewName: 'test_view',
    });
  });

  it('should throw ConfigError for missing SOURCE_HOST', () => {
    process.env.SOURCE_PORT = '6875';
    process.env.SOURCE_USER = 'materialize';
    process.env.SOURCE_PASSWORD = 'password';
    process.env.SOURCE_DB = 'materialize';
    process.env.VIEW_NAME = 'test_view';

    expect(() => loadDatabaseConfig()).toThrow(ConfigError);
    expect(() => loadDatabaseConfig()).toThrow('Missing required environment variable: SOURCE_HOST');
  });

  it('should throw ConfigError for invalid port', () => {
    process.env.SOURCE_HOST = 'localhost';
    process.env.SOURCE_PORT = 'invalid';
    process.env.SOURCE_USER = 'materialize';
    process.env.SOURCE_PASSWORD = 'password';
    process.env.SOURCE_DB = 'materialize';
    process.env.VIEW_NAME = 'test_view';

    expect(() => loadDatabaseConfig()).toThrow(ConfigError);
    expect(() => loadDatabaseConfig()).toThrow('SOURCE_PORT must be a valid port number');
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

    // Create the schema file in a location that the path resolution will find
    const realConfigDir = join(process.cwd(), 'config');
    mkdirSync(realConfigDir, { recursive: true });
    writeFileSync(join(realConfigDir, 'schema.sdl'), schemaContent);

    try {
      const schema = loadSchema();
      
      expect(schema.typeDefs).toContain('type TestType');
      expect(schema.primaryKeyField).toBe('id');
      expect(schema.fields).toHaveLength(3);
      expect(schema.fields[0]).toEqual({
        name: 'id',
        type: 'ID',
        nullable: false,
        isPrimaryKey: true,
      });
    } finally {
      // Clean up
      rmSync(realConfigDir, { recursive: true, force: true });
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

    const realConfigDir = join(process.cwd(), 'config');
    mkdirSync(realConfigDir, { recursive: true });
    writeFileSync(join(realConfigDir, 'schema.sdl'), invalidSchema);

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Schema must contain exactly one field of type ID!');
    } finally {
      rmSync(realConfigDir, { recursive: true, force: true });
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

    const realConfigDir = join(process.cwd(), 'config');
    mkdirSync(realConfigDir, { recursive: true });
    writeFileSync(join(realConfigDir, 'schema.sdl'), multiTypeSchema);

    try {
      expect(() => loadSchema()).toThrow(ConfigError);
      expect(() => loadSchema()).toThrow('Schema must contain exactly one data type definition (found 2)');
    } finally {
      rmSync(realConfigDir, { recursive: true, force: true });
    }
  });
});