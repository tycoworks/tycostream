import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StreamingService } from './streaming.service';
import { DatabaseStreamService } from '../database/stream.service';
import { MaterializeProtocolHandler } from '../database/materialize';
import type { SourceDefinition } from '../config/source.types';

/**
 * Manages multiple StreamingService instances for different sources
 * Provides a unified interface for streaming database updates
 */
@Injectable()
export class StreamingManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StreamingManagerService.name);
  private readonly streamingServices = new Map<string, StreamingService>();
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
   * Clean up all active streaming services on shutdown
   */
  async onModuleDestroy() {
    this.logger.log('Shutting down streaming manager...');
    
    // Clean up all streaming services
    // Note: We call onModuleDestroy() directly because these services
    // are dynamically created and not managed by NestJS DI container
    const cleanupPromises = Array.from(this.streamingServices.values()).map(
      service => service.onModuleDestroy()
    );
    
    await Promise.all(cleanupPromises);
    this.streamingServices.clear();
    this.logger.log('Streaming manager shutdown complete');
  }

  /**
   * Get the streaming service instance for a source
   * Used by ViewService to access raw streams
   */
  getStreamingService(sourceName: string): StreamingService {
    const sourceDef = this.sourceDefinitions.get(sourceName);
    if (!sourceDef) {
      throw new Error(`Unknown source: ${sourceName}. Available sources: ${Array.from(this.sourceDefinitions.keys()).join(', ')}`);
    }

    let streamingService = this.streamingServices.get(sourceName);
    if (!streamingService) {
      streamingService = this.createStreamingService(sourceDef);
      this.streamingServices.set(sourceName, streamingService);
      
      this.logger.log(`Created streaming service for source: ${sourceName}`);
    }

    return streamingService;
  }

  /**
   * Create a streaming service with protocol handler for a source
   */
  private createStreamingService(sourceDef: SourceDefinition): StreamingService {
    // Create protocol handler for this source
    const protocolHandler = new MaterializeProtocolHandler(sourceDef, sourceDef.name);
    
    // Create streaming service
    return new StreamingService(
      this.streamService,
      sourceDef,
      sourceDef.name,
      protocolHandler
    );
  }

}