import { logger } from '../shared/logger.js';
import { EVENTS } from '../shared/events.js';

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
    this.log.info('Shutting down tycostream');

    try {
      // Execute all shutdown handlers
      await Promise.all(
        this.handlers.map(async (handler, index) => {
          try {
            await handler();
          } catch (error) {
            this.log.error('Shutdown handler failed', { handlerIndex: index }, error as Error);
          }
        })
      );

      this.log.info('Shutdown complete');
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
        void this.shutdown(signal);
      });
    }

    process.on('uncaughtException', (error) => {
      this.log.error('Critical system error detected, shutting down tycostream', {}, error);
      void this.shutdown('uncaughtException');
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.log.error('Unexpected error detected, shutting down tycostream', { 
        reason: String(reason),
        promise: String(promise)
      });
      void this.shutdown('unhandledRejection');
    });
  }
}

export const shutdownManager = new ShutdownManager();