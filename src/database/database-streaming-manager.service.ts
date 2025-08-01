import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { DatabaseStreamingService } from './database-streaming.service';
import { DatabaseConnectionService } from './database-connection.service';
import { MaterializeProtocolHandler } from './materialize-protocol';
import type { SourceDefinition } from '../config/source-definition.types';
import type { RowUpdateEvent } from './types';

/**
 * Manages multiple DatabaseStreamingService instances for different sources
 * Provides a unified interface for streaming database updates
 */
@Injectable()
export class DatabaseStreamingManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseStreamingManagerService.name);
  private readonly streamingServices = new Map<string, DatabaseStreamingService>();
  private readonly sourceDefinitions = new Map<string, SourceDefinition>();

  constructor(
    private configService: ConfigService,
    private connectionService: DatabaseConnectionService
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
   * Get list of all configured source names
   */
  getAvailableSources(): string[] {
    return Array.from(this.sourceDefinitions.keys());
  }

  /**
   * Get source definition for a specific source
   */
  getSourceDefinition(sourceName: string): SourceDefinition | undefined {
    return this.sourceDefinitions.get(sourceName);
  }

  /**
   * Get streaming updates for a specific source
   * Creates the streaming service lazily on first request
   */
  getUpdates(sourceName: string): Observable<RowUpdateEvent> {
    const sourceDef = this.sourceDefinitions.get(sourceName);
    if (!sourceDef) {
      throw new Error(`Unknown source: ${sourceName}. Available sources: ${this.getAvailableSources().join(', ')}`);
    }

    // Get or create streaming service for this source
    let streamingService = this.streamingServices.get(sourceName);
    if (!streamingService) {
      streamingService = this.createStreamingService(sourceDef);
      this.streamingServices.set(sourceName, streamingService);
      
      this.logger.log(`Created streaming service for source: ${sourceName}`);
    }

    return streamingService.getUpdates();
  }


  /**
   * Stop streaming for a specific source
   * Cleans up the service and removes it from the active services map
   */
  async stopStreaming(sourceName: string): Promise<void> {
    const streamingService = this.streamingServices.get(sourceName);
    if (streamingService) {
      await streamingService.onModuleDestroy();
      this.streamingServices.delete(sourceName);
      this.logger.log(`Stopped streaming for source: ${sourceName}`);
    }
  }

  /**
   * Create a streaming service with protocol handler for a source
   */
  private createStreamingService(sourceDef: SourceDefinition): DatabaseStreamingService {
    // Create protocol handler for this source
    const protocolHandler = new MaterializeProtocolHandler(sourceDef, sourceDef.name);
    
    // Create streaming service
    return new DatabaseStreamingService(
      this.connectionService,
      sourceDef,
      sourceDef.name,
      protocolHandler
    );
  }

  // Internal methods for testing only
  /** @internal */
  _getStreamingService(sourceName: string): DatabaseStreamingService | undefined {
    return this.streamingServices.get(sourceName);
  }

  /** @internal */
  _getStreamingServiceCount(): number {
    return this.streamingServices.size;
  }
}