import databaseConfig from './database.config.js';

const SETTINGS = ['DATABASE_MAX_CONNECTIONS', 'DATABASE_QUERY_TIMEOUT_MS'];

describe('database config', () => {
  const saved = new Map(SETTINGS.map((name) => [name, process.env[name]]));

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it('should default to at most 1000 connections and a 30 s time limit on queries', () => {
    for (const name of SETTINGS) {
      delete process.env[name];
    }

    expect(databaseConfig()).toEqual(
      expect.objectContaining({ maxConnections: 1000, queryTimeoutMs: 30000 }),
    );
  });

  it('should read the cap and the time limit from the environment', () => {
    process.env.DATABASE_MAX_CONNECTIONS = '3';
    process.env.DATABASE_QUERY_TIMEOUT_MS = '1500';

    expect(databaseConfig()).toEqual(
      expect.objectContaining({ maxConnections: 3, queryTimeoutMs: 1500 }),
    );
  });

  it.each([
    ['DATABASE_MAX_CONNECTIONS', '0'],
    ['DATABASE_MAX_CONNECTIONS', 'many'],
    ['DATABASE_QUERY_TIMEOUT_MS', '-1'],
    ['DATABASE_QUERY_TIMEOUT_MS', 'soon'],
  ])('should reject %s=%s', (name, value) => {
    process.env[name] = value;

    expect(() => databaseConfig()).toThrow(
      'Invalid configuration for database',
    );
  });
});
