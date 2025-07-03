import pino from 'pino';
import { getLogLevel } from '../src/config.js';

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

export { logger };