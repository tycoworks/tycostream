import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Source } from './streaming.service';
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
    
    // Create source
    return new Source(
      this.streamService,
      sourceDef,
      sourceDef.name,
      protocolHandler
    );
  }

}