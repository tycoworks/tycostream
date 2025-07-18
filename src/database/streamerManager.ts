import type { DatabaseStreamer } from './types.js';
import type { DatabaseConfig } from '../core/config.js';
import type { LoadedSchema } from '../core/schema.js';
import { MaterializeStreamer } from './materialize.js';
import { logger } from '../core/logger.js';

export class StreamerManager {
  private streamers: Map<string, DatabaseStreamer> = new Map();
  private log = logger.child({ component: 'streamer-manager' });

  constructor(
    private dbConfig: DatabaseConfig,
    private schema: LoadedSchema
  ) {}

  async start(): Promise<void> {
    this.log.info('Starting streamers', { sourceCount: this.schema.sources.size });
    
    for (const [sourceName, sourceSchema] of this.schema.sources) {
      this.log.debug('Creating streamer', { sourceName });
      const streamer = new MaterializeStreamer(this.dbConfig, sourceSchema);
      await streamer.start();
      this.streamers.set(sourceName, streamer);
      this.log.info('Streamer created and started', { sourceName });
    }
  }

  getStreamer(sourceName: string): DatabaseStreamer | undefined {
    return this.streamers.get(sourceName);
  }

  getAllStreamers(): Map<string, DatabaseStreamer> {
    return new Map(this.streamers);
  }

  async stop(): Promise<void> {
    this.log.info('Closing all streamers', { count: this.streamers.size });
    
    const closePromises = Array.from(this.streamers.entries()).map(
      async ([viewName, streamer]) => {
        try {
          await streamer.stop();
          this.log.debug('Streamer closed', { viewName });
        } catch (error) {
          this.log.error('Error closing streamer', { viewName, error });
        }
      }
    );

    await Promise.all(closePromises);
    this.streamers.clear();
  }
}