import { validateConfig } from './config.validation';

describe('ConfigValidation', () => {
  it('should validate correct configuration', () => {
    const validConfig = {
      database: {
        host: 'localhost',
        port: 5432,
        user: 'test',
        password: 'test',
        database: 'test',
      },
      graphql: {
        port: 4000,
        playground: true,
      },
      app: {
        logLevel: 'info',
        schemaPath: './config/schema.yaml',
      },
    };

    expect(() => validateConfig(validConfig)).not.toThrow();
  });

  it('should throw on invalid database port', () => {
    const invalidConfig = {
      database: {
        host: 'localhost',
        port: 99999, // Invalid port
        user: 'test',
        password: 'test',
        database: 'test',
      },
      graphql: {
        port: 4000,
        playground: true,
      },
      app: {
        logLevel: 'info',
        schemaPath: './config/schema.yaml',
      },
    };

    expect(() => validateConfig(invalidConfig)).toThrow(/port/);
  });

  it('should throw on missing required fields', () => {
    const invalidConfig = {
      database: {
        host: 'localhost',
        port: 5432,
        // Missing user, password, database
      },
      graphql: {
        port: 4000,
        playground: true,
      },
      app: {
        logLevel: 'info',
      },
    };

    expect(() => validateConfig(invalidConfig)).toThrow(/configuration validation failed/);
  });
});