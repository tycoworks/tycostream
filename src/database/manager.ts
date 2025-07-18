import type { DatabaseSubscriber } from './types.js';
import type { DatabaseConfig } from '../core/config.js';
import type { GraphQLSchema } from '../core/schema.js';
import { MaterializeDatabaseSubscriber } from './materialize.js';
import { logger } from '../core/logger.js';

export class DatabaseSubscriberManager {
  private subscribers: Map<string, DatabaseSubscriber> = new Map();
  private log = logger.child({ component: 'subscriber-manager' });

  constructor(
    private dbConfig: DatabaseConfig,
    private schema: GraphQLSchema
  ) {}

  async start(): Promise<void> {
    this.log.info('Starting subscribers', { sourceCount: this.schema.sources.size });
    
    for (const [sourceName, sourceSchema] of this.schema.sources) {
      this.log.debug('Creating subscriber', { sourceName });
      const subscriber = new MaterializeDatabaseSubscriber(this.dbConfig, sourceSchema);
      await subscriber.start();
      this.subscribers.set(sourceName, subscriber);
      this.log.info('Subscriber created and started', { sourceName });
    }
  }

  getSubscriber(sourceName: string): DatabaseSubscriber | undefined {
    return this.subscribers.get(sourceName);
  }

  getAllSubscribers(): Map<string, DatabaseSubscriber> {
    return new Map(this.subscribers);
  }

  async stop(): Promise<void> {
    this.log.info('Closing all subscribers', { count: this.subscribers.size });
    
    const closePromises = Array.from(this.subscribers.entries()).map(
      async ([sourceName, subscriber]) => {
        try {
          await subscriber.stop();
          this.log.debug('Subscriber closed', { sourceName });
        } catch (error) {
          this.log.error('Error closing subscriber', { sourceName, error });
        }
      }
    );

    await Promise.all(closePromises);
    this.subscribers.clear();
  }
}