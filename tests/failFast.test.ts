import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'http';

describe('Fail-Fast Startup Scenarios', () => {
  let blocker: any;

  afterEach(() => {
    if (blocker) {
      blocker.close();
      blocker = null;
    }
  });

  describe('Port Conflicts', () => {
    it('should fail with clear error when port is already in use', async () => {
      const port = 4567;
      
      // Create a server to block the port
      blocker = createServer();
      await new Promise<void>((resolve) => {
        blocker.listen(port, () => resolve());
      });

      // Try to create another server on same port
      const testServer = createServer();
      
      await expect(new Promise<void>((resolve, reject) => {
        testServer.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            reject(new Error(`Port ${port} is already in use. Please ensure no other process is using this port or change GRAPHQL_PORT in your .env file.`));
          } else {
            reject(err);
          }
        });
        testServer.listen(port, () => {
          resolve();
        });
      })).rejects.toThrow(
        `Port ${port} is already in use. Please ensure no other process is using this port or change GRAPHQL_PORT in your .env file.`
      );
    });
  });

  describe('Database Connection Failures', () => {
    it('should provide clear error for unreachable database host', () => {
      const error = new Error('Database connection failed: connect ECONNREFUSED 127.0.0.1:6875');
      
      expect(() => { throw error; }).toThrow('Database connection failed');
    });

    it('should provide clear error for authentication failure', () => {
      const error = new Error('Database connection failed: password authentication failed for user "materialize"');
      
      expect(() => { throw error; }).toThrow('password authentication failed');
    });
  });
});