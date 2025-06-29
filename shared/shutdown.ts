import { logger } from './logger.js';
import { EVENTS } from './events.js';

export type ShutdownHandler = () => Promise<void> | void;

export class ShutdownManager {
  private log = logger.child({ component: 'shutdown' });
  private handlers: ShutdownHandler[] = [];
  private isShuttingDown = false;

  constructor() {
    this.setupSignalHandlers();
  }

  addHandler(handler: ShutdownHandler): void {
    this.handlers.push(handler);
  }

  async shutdown(signal?: string): Promise<void> {
    if (this.isShuttingDown) {
      this.log.warn('Shutdown already in progress, ignoring duplicate signal', { signal });
      return;
    }

    this.isShuttingDown = true;
    this.log.info('Initiating graceful shutdown', { signal, handlersCount: this.handlers.length });

    try {
      // Execute all shutdown handlers
      await Promise.all(
        this.handlers.map(async (handler, index) => {
          try {
            this.log.debug('Executing shutdown handler', { handlerIndex: index });
            await handler();
            this.log.debug('Shutdown handler completed', { handlerIndex: index });
          } catch (error) {
            this.log.error('Shutdown handler failed', { handlerIndex: index }, error as Error);
          }
        })
      );

      this.log.info('Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      this.log.error('Shutdown process failed', {}, error as Error);
      process.exit(1);
    }
  }

  private setupSignalHandlers(): void {
    const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    
    for (const signal of signals) {
      process.on(signal, () => {
        this.log.info('Received shutdown signal', { signal });
        void this.shutdown(signal);
      });
    }

    process.on('uncaughtException', (error) => {
      this.log.error('Uncaught exception - initiating emergency shutdown', {}, error);
      void this.shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.log.error('Unhandled promise rejection - initiating emergency shutdown', { 
        reason: String(reason),
        promise: String(promise)
      });
      void this.shutdown('unhandledRejection');
    });
  }
}

export const shutdownManager = new ShutdownManager();