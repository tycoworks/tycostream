import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DatabaseConnection } from './connection.js';
import { Client } from 'pg';
import { logger } from '../core/logger.js';

vi.mock('pg');
vi.mock('../core/logger.js', () => ({
  logger: {
    child: vi.fn().mockReturnValue({
      info: vi.fn(),
      error: vi.fn()
    })
  }
}));

describe('DatabaseConnection', () => {
  let connection: DatabaseConnection;
  let mockClient: any;
  let mockLogger: any;

  beforeEach(() => {
    vi.clearAllMocks();
    connection = new DatabaseConnection();
    mockLogger = logger.child({});
    
    mockClient = {
      connect: vi.fn(),
      end: vi.fn()
    };
    
    vi.mocked(Client).mockImplementation(() => mockClient);
  });

  describe('connect', () => {
    const testConfig = {
      host: 'localhost',
      port: 6875,
      user: 'materialize',
      password: 'password',
      database: 'materialize'
    };

    it('should successfully connect to database', async () => {
      mockClient.connect.mockResolvedValue(undefined);

      const client = await connection.connect(testConfig);

      expect(Client).toHaveBeenCalledWith({
        host: 'localhost',
        port: 6875,
        database: 'materialize',
        user: 'materialize',
        password: 'password',
        connectionTimeoutMillis: 10000,
        query_timeout: 0,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000
      });

      expect(mockClient.connect).toHaveBeenCalled();
      expect(client).toBe(mockClient);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Connecting to streaming database',
        {
          host: 'localhost',
          port: 6875,
          database: 'materialize',
          user: 'materialize'
        }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Connected to streaming database');
    });

    it('should handle connection refused error', async () => {
      const connectionError = new Error('connect ECONNREFUSED 127.0.0.1:6875');
      mockClient.connect.mockRejectedValue(connectionError);

      await expect(connection.connect(testConfig)).rejects.toThrow(
        'Database connection failed: connect ECONNREFUSED 127.0.0.1:6875'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to connect to streaming database',
        {},
        connectionError
      );
    });

    it('should handle authentication failure', async () => {
      const authError = new Error('password authentication failed for user "materialize"');
      mockClient.connect.mockRejectedValue(authError);

      await expect(connection.connect(testConfig)).rejects.toThrow(
        'Database connection failed: password authentication failed for user "materialize"'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to connect to streaming database',
        {},
        authError
      );
    });

    it('should handle timeout error', async () => {
      const timeoutError = new Error('timeout expired');
      mockClient.connect.mockRejectedValue(timeoutError);

      await expect(connection.connect(testConfig)).rejects.toThrow(
        'Database connection failed: timeout expired'
      );
    });
  });

  describe('disconnect', () => {
    it('should successfully disconnect from database', async () => {
      mockClient.end.mockResolvedValue(undefined);

      await connection.disconnect(mockClient);

      expect(mockClient.end).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Database connection closed');
    });

    it('should handle disconnect errors', async () => {
      const disconnectError = new Error('Connection already closed');
      mockClient.end.mockRejectedValue(disconnectError);

      await expect(connection.disconnect(mockClient)).rejects.toThrow(
        'Connection already closed'
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during disconnect',
        {},
        disconnectError
      );
    });
  });
});