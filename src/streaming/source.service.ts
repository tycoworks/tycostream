import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Source } from './source';
import { DatabaseStreamService } from '../database/stream.service';
import { MaterializeProtocolHandler } from '../database/materialize';
import type { SourceDefinition } from '../config/source.types';

/**
 * Manages multiple Source instances for different data sources
 * Provides a unified interface for streaming database updates
 */
@Injectable()
export class SourceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SourceService.name);
  private readonly sources = new Map<string, Source>();
  private readonly sourceDefinitions = new Map<string, SourceDefinition>();

  constructor(
    private configService: ConfigService,
    private streamService: DatabaseStreamService
  ) {}

  /**
   * Load source definitions from configuration on startup
   */
  async onModuleInit() {
    // Load source definitions from config
    const sources = this.configService.get<Map<string, SourceDefinition>>('sources');
    
    if (!sources || sources.size === 0) {
      this.logger.warn('No source definitions loaded');
      return;
    }

    // Store source definitions
    for (const [sourceName, sourceDef] of sources.entries()) {
      this.sourceDefinitions.set(sourceName, sourceDef);
    }

    this.logger.log(`Initialized streaming manager for ${this.sourceDefinitions.size} sources: ${Array.from(this.sourceDefinitions.keys()).join(', ')}`);
  }

  /**
   * Clean up all active sources on shutdown
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down source service...');
    
    // Clean up all sources
    // Note: We call onModuleDestroy() directly because these sources
    // are dynamically created and not managed by NestJS DI container
    const cleanupPromises = Array.from(this.sources.values()).map(
      source => source.onModuleDestroy()
    );
    
    await Promise.all(cleanupPromises);
    this.sources.clear();
    this.logger.log('Source service shutdown complete');
  }

  /**
   * Get the source instance for a data source
   * Used by ViewService to access raw streams
   */
  getSource(sourceName: string): Source {
    const sourceDef = this.sourceDefinitions.get(sourceName);
    if (!sourceDef) {
      throw new Error(`Unknown source: ${sourceName}. Available sources: ${Array.from(this.sourceDefinitions.keys()).join(', ')}`);
    }

    let source = this.sources.get(sourceName);
    
    // Check if existing source is disposed and needs recreation
    if (source && source.isDisposed) {
      this.logger.debug(`Source ${sourceName} is disposed, already cleaned up`);
      source = undefined;
    }
    
    if (!source) {
      source = this.createSource(sourceDef);
      this.sources.set(sourceName, source);
      
      this.logger.log(`Created source for: ${sourceName}`);
    }

    return source;
  }

  /**
   * Create a source with protocol handler for a data source
   */
  private createSource(sourceDef: SourceDefinition): Source {
    // Create protocol handler for this source
    const protocolHandler = new MaterializeProtocolHandler(sourceDef, sourceDef.name);
    
    // Get or create the database stream
    const databaseStream = this.streamService.getStream(sourceDef.name, protocolHandler);
    
    // Create source with the stream instance and cleanup callback
    return new Source(
      databaseStream,
      sourceDef,
      () => this.removeSource(sourceDef.name)
    );
  }

  /**
   * Remove a source when it's no longer needed
   * Called by Source when disposing itself
   */
  removeSource(sourceName: string): void {
    const source = this.sources.get(sourceName);
    if (source) {
      this.logger.log(`Removing source: ${sourceName}`);
      // Remove from sources map
      this.sources.delete(sourceName);
      // Remove the associated database stream
      this.streamService.removeStream(sourceName);
    }
  }

}