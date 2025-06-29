import type { LogLevel, LogContext } from './types.js';

export class Logger {
  constructor(private defaultContext: LogContext = {}) {}

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    const errorContext = error ? { 
      ...context, 
      error: error.message, 
      stack: error.stack 
    } : context;
    this.log('error', message, errorContext);
  }

  child(context: LogContext): Logger {
    return new Logger({ ...this.defaultContext, ...context });
  }

  private log(level: LogLevel, message: string, context?: LogContext): void {
    const timestamp = new Date().toISOString();
    const logContext = { ...this.defaultContext, ...context };
    
    const logEntry = {
      timestamp,
      level,
      message,
      ...logContext,
    };

    // Use JSON.stringify for structured logging
    const logLine = JSON.stringify(logEntry);
    
    if (level === 'error' || level === 'warn') {
      console.error(logLine);
    } else {
      console.log(logLine);
    }
  }
}

export const logger = new Logger({ component: 'tycostream' });