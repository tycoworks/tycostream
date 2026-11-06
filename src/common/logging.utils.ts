/**
 * Truncate data for logging to avoid huge log entries
 * Defaults to 100 characters with ellipsis for longer strings
 */
import { LogLevel } from '@nestjs/common';

const DEFAULT_TRUNCATE_LENGTH = 100;

export function truncateForLog(
  data: unknown,
  maxLength: number = DEFAULT_TRUNCATE_LENGTH,
): string {
  const str = JSON.stringify(data);
  if (!str || str.length <= maxLength) {
    return str || 'undefined';
  }
  return str.substring(0, maxLength) + '...';
}

/**
 * LOG_LEVEL values mapped to the matching NestJS level.
 * GraphQL Yoga's logger reads LOG_LEVEL too and rejects any other value,
 * so LOG_LEVEL takes Yoga's names: trace, debug, info, warn or error.
 * (Yoga's error message also lists false, but its logger rejects that too.)
 */
const NEST_LEVEL_FOR: Record<string, LogLevel> = {
  error: 'error',
  warn: 'warn',
  info: 'log',
  debug: 'debug',
  trace: 'verbose',
};

/**
 * Get enabled NestJS log levels for a LOG_LEVEL value.
 * NestJS uses cumulative log levels, so 'debug' includes error, warn, log, and debug.
 */
export function getLogLevels(logLevel: string = 'info'): LogLevel[] {
  const levels: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];
  const index = levels.indexOf(NEST_LEVEL_FOR[logLevel]);
  return index >= 0 ? levels.slice(0, index + 1) : ['error', 'warn', 'log'];
}
