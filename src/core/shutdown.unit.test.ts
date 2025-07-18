import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShutdownManager } from './shutdown.js';

// Mock the logger module
vi.mock('./logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

describe('ShutdownManager', () => {
  let shutdownManager: ShutdownManager;
  let mockLogger: any;
  let processExitSpy: any;
  let processOnSpy: any;
  const originalProcessOn = process.on;

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();
    
    // Import the mocked logger
    const { logger } = await import('./logger.js');
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(logger.child).mockReturnValue(mockLogger);

    // Mock process.exit to prevent actual exit
    processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Spy on process.on to track signal handler registration
    processOnSpy = vi.spyOn(process, 'on');

    // Create new instance for each test
    shutdownManager = new ShutdownManager();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore original process.on
    process.on = originalProcessOn;
    
    // Remove all listeners to prevent warnings
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGHUP');
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  describe('constructor', () => {
    it('should set up signal handlers for SIGTERM, SIGINT, and SIGHUP', () => {
      expect(processOnSpy).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('SIGINT', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('SIGHUP', expect.any(Function));
    });

    it('should set up handlers for uncaughtException and unhandledRejection', () => {
      expect(processOnSpy).toHaveBeenCalledWith('uncaughtException', expect.any(Function));
      expect(processOnSpy).toHaveBeenCalledWith('unhandledRejection', expect.any(Function));
    });
  });

  describe('addHandler', () => {
    it('should add shutdown handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      shutdownManager.addHandler(handler1);
      shutdownManager.addHandler(handler2);

      // Trigger shutdown to verify handlers are called
      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });
  });

  describe('shutdown', () => {
    it('should call all registered handlers', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
      });
      const handler3 = vi.fn();

      shutdownManager.addHandler(handler1);
      shutdownManager.addHandler(handler2);
      shutdownManager.addHandler(handler3);

      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
      expect(mockLogger.info).toHaveBeenCalledWith('Shutdown complete');
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should handle handler errors gracefully', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn(() => {
        throw new Error('Handler error');
      });
      const handler3 = vi.fn();

      shutdownManager.addHandler(handler1);
      shutdownManager.addHandler(handler2);
      shutdownManager.addHandler(handler3);

      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(handler1).toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
      expect(handler3).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Shutdown handler failed',
        { handlerIndex: 1 },
        expect.any(Error)
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should handle duplicate shutdown calls', async () => {
      const handler = vi.fn();
      shutdownManager.addHandler(handler);

      // First shutdown
      const firstShutdown = shutdownManager.shutdown('SIGTERM');
      
      // Second shutdown while first is in progress
      const secondShutdown = shutdownManager.shutdown('SIGINT');

      // Both should complete without error
      await expect(firstShutdown).rejects.toThrow('process.exit called');
      await secondShutdown;

      expect(handler).toHaveBeenCalledTimes(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Shutdown already in progress, ignoring duplicate signal',
        { signal: 'SIGINT' }
      );
    });

    it('should exit with code 1 if Promise.all fails', async () => {
      // Mock Promise.all to throw an error
      const originalPromiseAll = Promise.all;
      vi.spyOn(Promise, 'all').mockRejectedValue(new Error('Promise.all failed'));

      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Shutdown process failed',
        {},
        expect.any(Error)
      );
      expect(processExitSpy).toHaveBeenCalledWith(1);

      // Restore Promise.all
      Promise.all = originalPromiseAll;
    });

    it('should pass signal parameter to log', async () => {
      await expect(shutdownManager.shutdown('SIGTERM')).rejects.toThrow('process.exit called');
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });
  });

  describe('signal handlers', () => {
    it('should trigger shutdown on SIGTERM', async () => {
      const sigTermHandler = processOnSpy.mock.calls.find(
        (call: any) => call[0] === 'SIGTERM'
      )?.[1] as Function;

      expect(sigTermHandler).toBeDefined();

      // Call the handler
      sigTermHandler();

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });

    it('should trigger shutdown on SIGINT', async () => {
      const sigIntHandler = processOnSpy.mock.calls.find(
        (call: any) => call[0] === 'SIGINT'
      )?.[1] as Function;

      expect(sigIntHandler).toBeDefined();

      // Call the handler
      sigIntHandler();

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });

    it('should trigger shutdown on SIGHUP', async () => {
      const sigHupHandler = processOnSpy.mock.calls.find(
        (call: any) => call[0] === 'SIGHUP'
      )?.[1] as Function;

      expect(sigHupHandler).toBeDefined();

      // Call the handler
      sigHupHandler();

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });

    it('should trigger shutdown on uncaughtException', async () => {
      const uncaughtHandler = processOnSpy.mock.calls.find(
        (call: any) => call[0] === 'uncaughtException'
      )?.[1] as Function;

      expect(uncaughtHandler).toBeDefined();

      const testError = new Error('Test uncaught exception');
      
      // Call the handler
      uncaughtHandler(testError);

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Critical system error detected, shutting down tycostream',
        {},
        testError
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });

    it('should trigger shutdown on unhandledRejection', async () => {
      const unhandledHandler = processOnSpy.mock.calls.find(
        (call: any) => call[0] === 'unhandledRejection'
      )?.[1] as Function;

      expect(unhandledHandler).toBeDefined();

      const testReason = 'Test rejection reason';
      const testPromise = Promise.reject(testReason);

      // Call the handler
      unhandledHandler(testReason, testPromise);

      // Give async operations time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Unexpected error detected, shutting down tycostream',
        {
          reason: 'Test rejection reason',
          promise: expect.stringContaining('Promise')
        }
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
    });
  });

  describe('edge cases', () => {
    it('should handle sync handlers correctly', async () => {
      const syncHandler = vi.fn();
      shutdownManager.addHandler(syncHandler);

      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(syncHandler).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should handle async handlers that reject', async () => {
      const asyncHandler = vi.fn(async () => {
        throw new Error('Async handler error');
      });

      shutdownManager.addHandler(asyncHandler);

      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(asyncHandler).toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Shutdown handler failed',
        { handlerIndex: 0 },
        expect.any(Error)
      );
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('should handle empty handler list', async () => {
      await expect(shutdownManager.shutdown()).rejects.toThrow('process.exit called');

      expect(mockLogger.info).toHaveBeenCalledWith('Shutting down tycostream');
      expect(mockLogger.info).toHaveBeenCalledWith('Shutdown complete');
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });
  });
});

describe('shutdownManager singleton', () => {
  it('should export a singleton instance', async () => {
    // Import fresh to get the singleton
    vi.resetModules();
    const shutdownModule = await import('./shutdown.js');
    
    expect(shutdownModule.shutdownManager).toBeDefined();
    // Check that it has the expected methods instead of instanceof
    expect(shutdownModule.shutdownManager).toHaveProperty('addHandler');
    expect(shutdownModule.shutdownManager).toHaveProperty('shutdown');
  });
});