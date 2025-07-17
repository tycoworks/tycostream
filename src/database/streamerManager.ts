import type { DatabaseStreamer } from './types.js';
import type { DatabaseConfig } from '../core/config.js';
import type { LoadedSchema, ViewSchema } from '../core/schema.js';
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
    this.log.info('Starting streamers', { viewCount: this.schema.views.size });
    
    for (const [viewName, viewSchema] of this.schema.views) {
      this.log.debug('Creating streamer', { viewName });
      const streamer = new MaterializeStreamer(this.dbConfig, viewSchema);
      await streamer.start();
      this.streamers.set(viewName, streamer);
      this.log.info('Streamer created and started', { viewName });
    }
  }

  getStreamer(viewName: string): DatabaseStreamer | undefined {
    return this.streamers.get(viewName);
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