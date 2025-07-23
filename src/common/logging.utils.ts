/**
 * Truncate data for logging to avoid huge log entries
 */
import { LogLevel } from '@nestjs/common';

export function truncateForLog(data: any, maxLength = 100): string {
  const str = JSON.stringify(data);
  if (str.length <= maxLength) {
    return str;
  }
  return str.substring(0, maxLength) + '...';
}

/**
 * Get enabled log levels based on minimum level.
 * NestJS uses cumulative log levels, so 'debug' includes error, warn, log, and debug.
 */
export function getLogLevels(minLevel: string = 'log'): LogLevel[] {
  const levels: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const index = levels.indexOf(minLevel as LogLevel);
  return index >= 0 ? levels.slice(0, index + 1) : ['error', 'warn', 'log'];
}