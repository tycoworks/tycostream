import { truncateForLog, getLogLevels } from './logging.utils';

describe('logging.utils', () => {
  describe('truncateForLog', () => {
    it('should return short strings unchanged', () => {
      const data = { message: 'Hello' };
      expect(truncateForLog(data)).toBe('{"message":"Hello"}');
    });

    it('should truncate long strings to default length', () => {
      const data = { message: 'a'.repeat(200) };
      const result = truncateForLog(data);
      expect(result.length).toBe(103); // 100 chars + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should truncate to custom length', () => {
      const data = { message: 'a'.repeat(50) };
      const result = truncateForLog(data, 20);
      expect(result.length).toBe(23); // 20 chars + '...'
      expect(result.endsWith('...')).toBe(true);
    });

    it('should handle complex objects', () => {
      const data = { 
        id: 1, 
        nested: { 
          array: [1, 2, 3], 
          bool: true 
        } 
      };
      const result = truncateForLog(data);
      expect(result).toContain('id');
      expect(result).toContain('nested');
    });

    it('should handle null and undefined', () => {
      expect(truncateForLog(null)).toBe('null');
      expect(truncateForLog(undefined)).toBe('undefined');
    });
  });

  describe('getLogLevels', () => {
    it('should return default log levels', () => {
      const levels = getLogLevels();
      expect(levels).toEqual(['error', 'warn', 'log']);
    });

    it('should return all levels for verbose', () => {
      const levels = getLogLevels('verbose');
      expect(levels).toEqual(['error', 'warn', 'log', 'debug', 'verbose']);
    });

    it('should return only error for error level', () => {
      const levels = getLogLevels('error');
      expect(levels).toEqual(['error']);
    });

    it('should return up to debug for debug level', () => {
      const levels = getLogLevels('debug');
      expect(levels).toEqual(['error', 'warn', 'log', 'debug']);
    });

    it('should handle invalid log level', () => {
      const levels = getLogLevels('invalid');
      expect(levels).toEqual(['error', 'warn', 'log']); // default
    });
  });
});