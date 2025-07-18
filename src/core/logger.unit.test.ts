import { describe, it, expect, vi, beforeEach } from 'vitest';
import { truncateForLog } from './logger.js';

vi.mock('./config.js', () => ({
  getLogLevel: vi.fn().mockReturnValue('info')
}));

describe('Logger Module', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('logger configuration', () => {
    it('should create logger with correct configuration', async () => {
      // Dynamically import to ensure mocks are in place
      const { getLogLevel } = await import('./config.js');
      vi.mocked(getLogLevel).mockReturnValue('debug');
      
      // Clear module cache and re-import
      vi.resetModules();
      const loggerModule = await import('./logger.js');
      
      expect(getLogLevel).toHaveBeenCalled();
      expect(loggerModule.logger).toBeDefined();
    });
  });

  describe('truncateForLog', () => {
    it('should return string as-is when shorter than maxLength', () => {
      const shortString = { message: 'short' };
      const result = truncateForLog(shortString);
      expect(result).toBe(JSON.stringify(shortString));
    });

    it('should truncate string when longer than default maxLength', () => {
      const longObject = { 
        message: 'a'.repeat(300),
        data: 'b'.repeat(100)
      };
      const result = truncateForLog(longObject);
      expect(result.length).toBe(203); // 200 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should truncate string when longer than custom maxLength', () => {
      const longObject = { message: 'a'.repeat(50) };
      const result = truncateForLog(longObject, 10);
      expect(result.length).toBe(13); // 10 + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle null values', () => {
      expect(truncateForLog(null)).toBe('null');
    });

    it('should handle edge cases', () => {
      expect(truncateForLog('')).toBe('""');
      expect(truncateForLog(0)).toBe('0');
      expect(truncateForLog(false)).toBe('false');
    });

    it('should handle complex objects', () => {
      const complexObject = {
        nested: {
          array: [1, 2, 3],
          string: 'test'
        },
        number: 42
      };
      const result = truncateForLog(complexObject);
      expect(result).toContain('nested');
      expect(result).toContain('array');
    });
  });
});