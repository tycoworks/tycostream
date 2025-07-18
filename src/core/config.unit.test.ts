import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  loadDatabaseConfig,
  getGraphQLPort,
  isGraphQLUIEnabled,
  getLogLevel,
  loadGraphQLSchema,
  ConfigError,
} from './config.js';

// Mock modules
vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

vi.mock('path', () => ({
  join: vi.fn((...paths) => paths.join('/')),
}));

vi.mock('dotenv', () => ({
  config: vi.fn(),
}));

vi.mock('./schema.js', () => ({
  loadGraphQLSchemaFromYaml: vi.fn(),
}));

const mockExistsSync = vi.fn();
const mockLoadGraphQLSchemaFromYaml = vi.fn();

beforeEach(async () => {
  // Import mocked modules
  const fs = await import('fs');
  const schema = await import('./schema.js');
  
  vi.mocked(fs.existsSync).mockImplementation(mockExistsSync);
  vi.mocked(schema.loadGraphQLSchemaFromYaml).mockImplementation(mockLoadGraphQLSchemaFromYaml);
  
  // Clear all mocks
  vi.clearAllMocks();
  
  // Reset module state by clearing the cache
  vi.resetModules();
  
  // Set NODE_ENV to test to prevent caching
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  // Clean up environment variables
  delete process.env.DATABASE_HOST;
  delete process.env.DATABASE_PORT;
  delete process.env.DATABASE_USER;
  delete process.env.DATABASE_PASSWORD;
  delete process.env.DATABASE_NAME;
  delete process.env.GRAPHQL_PORT;
  delete process.env.GRAPHQL_UI;
  delete process.env.LOG_LEVEL;
  delete process.env.NODE_ENV;
});

describe('ConfigError', () => {
  it('should create error with message and field', () => {
    const error = new ConfigError('Test error', 'TEST_FIELD');
    expect(error.message).toBe('Test error');
    expect(error.field).toBe('TEST_FIELD');
    expect(error.name).toBe('ConfigError');
  });

  it('should create error without field', () => {
    const error = new ConfigError('Test error');
    expect(error.message).toBe('Test error');
    expect(error.field).toBeUndefined();
  });
});

describe('loadDatabaseConfig', () => {
  beforeEach(() => {
    // Set up valid environment variables
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should load database configuration from environment variables', async () => {
    const { loadDatabaseConfig } = await import('./config.js');
    const config = loadDatabaseConfig();
    
    expect(config).toEqual({
      host: 'localhost',
      port: 5432,
      user: 'testuser',
      password: 'testpass',
      database: 'testdb',
    });
  });

  it('should throw ConfigError when required env vars are missing', async () => {
    delete process.env.DATABASE_HOST;
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
    expect(() => loadDatabaseConfig()).toThrow(/DATABASE_HOST/);
  });

  it('should throw ConfigError for invalid port number', async () => {
    process.env.DATABASE_PORT = 'invalid';
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
  });

  it('should throw ConfigError for port out of range', async () => {
    process.env.DATABASE_PORT = '99999';
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
  });
});

describe('getGraphQLPort', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should return default port when GRAPHQL_PORT not set', async () => {
    const { getGraphQLPort } = await import('./config.js');
    expect(getGraphQLPort()).toBe(4000);
  });

  it('should return custom port when GRAPHQL_PORT is set', async () => {
    process.env.GRAPHQL_PORT = '8080';
    
    const { getGraphQLPort } = await import('./config.js');
    expect(getGraphQLPort()).toBe(8080);
  });

  it('should throw ConfigError for invalid GRAPHQL_PORT', async () => {
    process.env.GRAPHQL_PORT = 'not-a-number';
    
    const { getGraphQLPort } = await import('./config.js');
    expect(() => getGraphQLPort()).toThrow('Configuration validation failed');
  });
});

describe('isGraphQLUIEnabled', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should return false by default', async () => {
    const { isGraphQLUIEnabled } = await import('./config.js');
    expect(isGraphQLUIEnabled()).toBe(false);
  });

  it('should return true when GRAPHQL_UI is "true"', async () => {
    process.env.GRAPHQL_UI = 'true';
    
    const { isGraphQLUIEnabled } = await import('./config.js');
    expect(isGraphQLUIEnabled()).toBe(true);
  });

  it('should return false when GRAPHQL_UI is "false"', async () => {
    process.env.GRAPHQL_UI = 'false';
    
    const { isGraphQLUIEnabled } = await import('./config.js');
    expect(isGraphQLUIEnabled()).toBe(false);
  });

  it('should throw ConfigError for invalid GRAPHQL_UI value', async () => {
    process.env.GRAPHQL_UI = 'maybe';
    
    const { isGraphQLUIEnabled } = await import('./config.js');
    expect(() => isGraphQLUIEnabled()).toThrow('Configuration validation failed');
  });
});

describe('getLogLevel', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should return "info" by default', async () => {
    const { getLogLevel } = await import('./config.js');
    expect(getLogLevel()).toBe('info');
  });

  it('should return custom log level when set', async () => {
    process.env.LOG_LEVEL = 'debug';
    
    const { getLogLevel } = await import('./config.js');
    expect(getLogLevel()).toBe('debug');
  });

  it('should accept all valid log levels', async () => {
    const validLevels = ['debug', 'info', 'warn', 'error'];
    
    for (const level of validLevels) {
      process.env.LOG_LEVEL = level;
      vi.resetModules();
      const { getLogLevel } = await import('./config.js');
      expect(getLogLevel()).toBe(level);
    }
  });

  it('should throw ConfigError for invalid log level', async () => {
    process.env.LOG_LEVEL = 'verbose';
    
    const { getLogLevel } = await import('./config.js');
    expect(() => getLogLevel()).toThrow('Configuration validation failed');
  });
});

describe('loadGraphQLSchema', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
    
    // Mock process.cwd()
    vi.spyOn(process, 'cwd').mockReturnValue('/test/project');
  });

  it('should load GraphQL schema from config directory', async () => {
    const mockSchema = { sources: new Map() };
    mockExistsSync.mockReturnValue(true);
    mockLoadGraphQLSchemaFromYaml.mockReturnValue(mockSchema);
    
    const { loadGraphQLSchema } = await import('./config.js');
    const schema = loadGraphQLSchema();
    
    expect(mockExistsSync).toHaveBeenCalledWith('/test/project/config');
    expect(mockLoadGraphQLSchemaFromYaml).toHaveBeenCalledWith('/test/project/config');
    expect(schema).toBe(mockSchema);
  });

  it('should use config path even when directory does not exist', async () => {
    const mockSchema = { sources: new Map() };
    mockExistsSync.mockReturnValue(false);
    mockLoadGraphQLSchemaFromYaml.mockReturnValue(mockSchema);
    
    const { loadGraphQLSchema } = await import('./config.js');
    const schema = loadGraphQLSchema();
    
    expect(mockLoadGraphQLSchemaFromYaml).toHaveBeenCalledWith('/test/project/config');
    expect(schema).toBe(mockSchema);
  });

  it('should handle existsSync throwing error', async () => {
    const mockSchema = { sources: new Map() };
    mockExistsSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });
    mockLoadGraphQLSchemaFromYaml.mockReturnValue(mockSchema);
    
    const { loadGraphQLSchema } = await import('./config.js');
    const schema = loadGraphQLSchema();
    
    expect(mockLoadGraphQLSchemaFromYaml).toHaveBeenCalledWith('/test/project/config');
    expect(schema).toBe(mockSchema);
  });

  it('should throw ConfigError when schema loading fails', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadGraphQLSchemaFromYaml.mockImplementation(() => {
      throw new Error('Invalid YAML');
    });
    
    const { loadGraphQLSchema } = await import('./config.js');
    
    expect(() => loadGraphQLSchema()).toThrow('Failed to load schema: Invalid YAML');
    
    try {
      loadGraphQLSchema();
    } catch (error) {
      // Need to import ConfigError locally since we're in a catch block
      const { ConfigError: LocalConfigError } = await import('./config.js');
      expect(error).toBeInstanceOf(LocalConfigError);
      expect((error as ConfigError).field).toBe('SCHEMA_FILE');
    }
  });

  it('should rethrow non-Error exceptions', async () => {
    mockExistsSync.mockReturnValue(true);
    mockLoadGraphQLSchemaFromYaml.mockImplementation(() => {
      throw 'String error';
    });
    
    const { loadGraphQLSchema } = await import('./config.js');
    
    expect(() => loadGraphQLSchema()).toThrow('String error');
  });
});

describe('Environment caching', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should not cache in test environment', async () => {
    process.env.NODE_ENV = 'test';
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    const config1 = loadDatabaseConfig();
    expect(config1.host).toBe('localhost');
    
    // Change env var
    process.env.DATABASE_HOST = 'newhost';
    
    const config2 = loadDatabaseConfig();
    expect(config2.host).toBe('newhost');
  });

  it('should cache in non-test environment', async () => {
    process.env.NODE_ENV = 'production';
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    const config1 = loadDatabaseConfig();
    expect(config1.host).toBe('localhost');
    
    // Change env var
    process.env.DATABASE_HOST = 'newhost';
    
    const config2 = loadDatabaseConfig();
    // Should still return cached value
    expect(config2.host).toBe('localhost');
  });
});

describe('Error handling edge cases', () => {
  beforeEach(() => {
    // Set up required database env vars
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = 'testuser';
    process.env.DATABASE_PASSWORD = 'testpass';
    process.env.DATABASE_NAME = 'testdb';
  });

  it('should handle non-ZodError exceptions', async () => {
    // Create a custom error mock
    vi.doMock('zod', async () => {
      const actual = await vi.importActual<typeof import('zod')>('zod');
      return {
        ...actual,
        z: {
          ...actual.z,
          object: () => ({
            parse: () => {
              throw new Error('Unexpected error');
            }
          })
        }
      };
    });
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    expect(() => loadDatabaseConfig()).toThrow('Unexpected error');
    
    // Clean up the mock
    vi.doUnmock('zod');
  });

  it('should include example values for missing env vars', async () => {
    // Create an error for a missing env var
    delete process.env.DATABASE_HOST;
    
    // Reset modules to ensure fresh import
    vi.resetModules();
    
    const { loadDatabaseConfig, ConfigError } = await import('./config.js');
    
    try {
      loadDatabaseConfig();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_HOST');
      expect(message).toContain('Example: DATABASE_HOST=localhost');
    }
  });
});

describe('Multiple environment variables validation', () => {
  it('should report all missing required variables', async () => {
    // Don't set any env vars - reset modules to ensure clean state
    vi.resetModules();
    
    const { loadDatabaseConfig, ConfigError } = await import('./config.js');
    
    try {
      loadDatabaseConfig();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain('DATABASE_HOST');
      expect(message).toContain('DATABASE_USER');
      expect(message).toContain('DATABASE_PASSWORD');
      expect(message).toContain('DATABASE_NAME');
    }
  });

  it('should handle empty string values', async () => {
    process.env.DATABASE_HOST = '';
    process.env.DATABASE_PORT = '5432';
    process.env.DATABASE_USER = '';
    process.env.DATABASE_PASSWORD = '';
    process.env.DATABASE_NAME = '';
    
    const { loadDatabaseConfig } = await import('./config.js');
    
    expect(() => loadDatabaseConfig()).toThrow('Configuration validation failed');
  });
});