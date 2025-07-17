import pino from 'pino';
import { getLogLevel } from './config.js';

// Logging types
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  component?: string;
  operation?: string;
  viewName?: string;
  clientId?: string;
  [key: string]: unknown;
}

// Component-specific configuration
const LOG_TRUNCATE_LENGTH = 200; // Balance between readability and completeness

// Configure Pino with environment-based log level
const logger = pino({
  level: getLogLevel(),
  formatters: {
    level: (label) => {
      return { level: label };
    },
    bindings: (bindings) => {
      // Remove pid and hostname for cleaner logs
      const { pid, hostname, ...rest } = bindings;
      return rest;
    }
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  messageKey: 'message',
  base: {
    component: 'tycostream'
  }
});

/**
 * Truncate object for logging to avoid massive log entries
 * @param obj - Object to serialize and truncate
 * @param maxLength - Maximum length before truncation (default: 200)
 * @returns Truncated JSON string
 */
export function truncateForLog(obj: unknown, maxLength: number = LOG_TRUNCATE_LENGTH): string {
  const jsonString = JSON.stringify(obj);
  return jsonString.length > maxLength 
    ? jsonString.substring(0, maxLength) + '...'
    : jsonString;
}

export { logger };