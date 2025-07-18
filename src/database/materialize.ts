import { Client } from 'pg';
import { to as copyTo, type CopyToStreamQuery } from 'pg-copy-streams';
import { Subject, ReplaySubject, filter } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import type { SourceSchema } from '../core/schema.js';
import type { RowUpdateEvent, DatabaseSubscriber } from './types.js';
import { RowUpdateType } from './types.js';
import type { DatabaseConfig } from '../core/config.js';
import { logger, truncateForLog } from '../core/logger.js';
import { SimpleCache } from './cache.js';
import { DatabaseConnection } from './connection.js';

/**
 * Materialize streaming database adapter
 * Handles connection management, Materialize-specific streaming protocol, subscription management, and data caching
 */
export class MaterializeDatabaseSubscriber implements DatabaseSubscriber {
  private log = logger.child({ component: 'materialize' });
  private isStreaming = false;
  private copyStream: CopyToStreamQuery | null = null;
  private dbConnection = new DatabaseConnection();
  private client: Client | null = null;
  private isShuttingDown = false;
  private cache: SimpleCache;
  private columnNames: string[];
  private updates$ = new Subject<RowUpdateEvent & { timestamp: bigint }>();
  private _subscriberCount = 0;

  constructor(
    private config: DatabaseConfig,
    private schema: SourceSchema
  ) {
    // Create internal simple cache
    this.cache = new SimpleCache(schema.primaryKeyField);
    
    // Initialize column names for COPY stream parsing
    // With ENVELOPE UPSERT, output format is: [mz_timestamp, mz_state, key_columns..., value_columns...]
    // Since key columns come first after mz_state, we need to reorder our fields
    const keyFields = schema.fields.filter(f => f.name === schema.primaryKeyField);
    const nonKeyFields = schema.fields.filter(f => f.name !== schema.primaryKeyField);
    this.columnNames = ['mz_timestamp', 'mz_state', ...keyFields.map(f => f.name), ...nonKeyFields.map(f => f.name)];
    
    this.log.debug('MaterializeDatabaseSubscriber initialized', { 
      columnCount: this.columnNames.length,
      columns: this.columnNames,
      primaryKeyField: schema.primaryKeyField
    });
  }

  /**
   * Start the database connection
   */
  async start(): Promise<void> {
    this.client = await this.dbConnection.connect(this.config);
  }

  /**
   * Stop the database connection
   */
  async stop(): Promise<void> {
    // Set shutdown flag first to prevent new subscriptions
    this.isShuttingDown = true;
    
    // Stop streaming if active
    if (this.isStreaming) {
      await this.stopStreaming();
    }
    
    if (this.client) {
      await this.dbConnection.disconnect(this.client);
      this.client = null;
    }
  }

  /**
   * Start streaming from a Materialize view
   */
  private async startStreaming(): Promise<void> {
    if (!this.client) {
      throw new Error('Client connection lost before streaming could start');
    }
    
    if (this.isStreaming) {
      this.log.warn('Stream already active', { sourceName: this.schema.sourceName });
      return;
    }

    // Set flag immediately to prevent concurrent starts
    this.isStreaming = true;
    
    try {
      this.log.info('Starting stream subscription', { sourceName: this.schema.sourceName });

      // Start streaming subscription with initial snapshot using COPY
      // Use ENVELOPE UPSERT to get clean upsert/delete events instead of -1/+1 retractions
      const keyColumn = this.schema.primaryKeyField;
      const subscribeQuery = `COPY (SUBSCRIBE TO ${this.schema.sourceName} ENVELOPE UPSERT (KEY (${keyColumn})) WITH (SNAPSHOT)) TO STDOUT`;
      this.log.debug('Executing streaming SUBSCRIBE query', { query: subscribeQuery });

      // Use pg-copy-streams for proper COPY streaming
      const copyToStream = copyTo(subscribeQuery);
      this.copyStream = this.client.query(copyToStream);

      // Handle stream data chunks
      this.copyStream.on('data', (chunk: Buffer) => {
        this.processChunk(chunk);
      });

      this.copyStream.on('end', () => {
        // Only warn about unexpected stream end
        if (!this.isShuttingDown) {
          this.log.warn('COPY stream ended', { sourceName: this.schema.sourceName });
        }
        this.isStreaming = false;
      });

      this.copyStream.on('error', (error: Error) => {
        // Don't log errors during intentional shutdown
        if (!this.isShuttingDown) {
          this.log.error('COPY stream error', { sourceName: this.schema.sourceName }, error);
          this.isStreaming = false; // Reset on error
          throw error;
        }
      });

      this.log.info('Stream subscription started', { sourceName: this.schema.sourceName });

    } catch (error) {
      this.isStreaming = false; // Reset on error
      this.log.error('Failed to start streaming', { sourceName: this.schema.sourceName }, error as Error);
      throw new Error(`Stream initialization failed: ${(error as Error).message}`);
    }
  }

  /**
   * Stop streaming
   */
  private async stopStreaming(): Promise<void> {
    this.isStreaming = false;
    
    if (this.copyStream) {
      try {
        this.log.debug('Closing COPY stream');
        this.copyStream.destroy();
        this.copyStream = null;
      } catch (error) {
        this.log.debug('Error closing COPY stream (may already be closed)', {}, error as Error);
      }
    }
    
    this.log.info('Stream stopped');
  }

  /**
   * Get streaming status
   */
  get streaming(): boolean {
    return this.isStreaming;
  }


  /**
   * Get async iterator for streaming updates with late-joiner support
   */
  async *getUpdates(): AsyncIterableIterator<RowUpdateEvent> {
    if (!this.client) {
      throw new Error('Database streamer must be started before subscribing. Call start() first.');
    }
    
    if (this.isShuttingDown) {
      throw new Error('Database streamer is shutting down, cannot accept new subscriptions');
    }
    
    // Increment subscriber count
    this._subscriberCount++;
    
    // 1. Create a replayable tee stream
    const tee$ = new ReplaySubject<RowUpdateEvent>();
    
    // 2. Begin teeing updates into it
    const teeSub = this.updates$.subscribe(event => tee$.next(event));
    
    // 3. Take snapshot and emit rows
    // Get timestamp first to avoid race condition
    const latestSeenTimestamp = this.cache.timestamp;
    const snapshot = this.cache.getAllRows();
    
    // Emit snapshot as insert events
    for (const row of snapshot) {
      yield {
        type: RowUpdateType.Insert,
        row: { ...row }
      };
    }
    
    // 4. Subscribe to tee$ with filter
    const liveSub = tee$.pipe(
      filter((event: RowUpdateEvent & { timestamp?: bigint }) => {
        // Only emit events newer than snapshot timestamp
        return event.timestamp ? event.timestamp > latestSeenTimestamp : true;
      })
    );
    
    // Start streaming if not already started (after all subscriptions are set up)
    if (!this.isStreaming) {
      this.startStreaming();
    }
    
    this.log.debug('Subscriber added', {
      sourceName: this.schema.sourceName,
      currentStateSize: this.cache.size,
      subscriberCount: this._subscriberCount
    });
    
    try {
      // Use rxjs-for-await to convert the observable to async iterable
      for await (const event of eachValueFrom(liveSub)) {
        yield event;
      }
    } finally {
      teeSub.unsubscribe();
      // Note: eachValueFrom handles its own subscription cleanup
      this._subscriberCount--;
      this.log.debug('Subscriber removed', {
        sourceName: this.schema.sourceName,
        subscriberCount: this._subscriberCount
      });
    }
  }

  /**
   * Get current state snapshot
   */
  getAllRows(): Record<string, any>[] {
    return this.cache.getAllRows();
  }

  /**
   * Get a specific row by primary key
   */
  getRow(primaryKey: string | number): Record<string, any> | undefined {
    return this.cache.get(primaryKey);
  }

  /**
   * Get subscriber count for monitoring
   */
  get subscriberCount(): number {
    return this._subscriberCount;
  }

  /**
   * Process a chunk of COPY stream data
   */
  private processChunk(chunk: Buffer): void {
    try {
      const lines = chunk.toString('utf8').split('\n');
      for (const line of lines) {
        this.processRow(line);
      }
    } catch (error) {
      this.log.error('Error processing COPY chunk', {}, error as Error);
    }
  }

  /**
   * Process a single line of COPY output
   */
  private processRow(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    const fields = trimmed.split('\t');
    if (fields.length < 2) return;

    // Parse timestamp (first field)
    const timestampField = fields[0];
    if (!timestampField) return;
    const timestamp = BigInt(timestampField);

    // Parse mz_state (second field) - either 'upsert' or 'delete'
    const mzState = fields[1];
    if (!mzState) return;

    // Map remaining fields to row data (skip mz_timestamp and mz_state)
    const row: Record<string, any> = {};
    for (let i = 2; i < fields.length && i < this.columnNames.length; i++) {
      const columnName = this.columnNames[i];
      const field = fields[i];
      if (columnName && field !== undefined) {
        row[columnName] = field === '\\N' ? null : field;
      }
    }

    // Apply the appropriate operation based on mz_state
    if (mzState === 'upsert') {
      this.applyOperation(row, timestamp, false); // insert or update
    } else if (mzState === 'delete') {
      this.applyOperation(row, timestamp, true);  // delete
    }
  }

  /**
   * Apply a data operation (upsert or delete)
   */
  private applyOperation(row: Record<string, any>, timestamp: bigint, isDelete: boolean): void {
    const primaryKey = row[this.schema.primaryKeyField];
    
    if (primaryKey === undefined || primaryKey === null) {
      this.log.warn('Data row missing required primary key field', {
        sourceName: this.schema.sourceName,
        primaryKeyField: this.schema.primaryKeyField,
        rowKeys: Object.keys(row),
        operation: isDelete ? 'delete' : 'upsert',
        suggestion: `Check that your view has a field named '${this.schema.primaryKeyField}' with type ID!`
      });
      return;
    }

    let eventType: RowUpdateType;
    
    if (isDelete) {
      // Delete operation
      const deleted = this.cache.delete(row);
      if (!deleted) return;
      eventType = RowUpdateType.Delete;
    } else {
      // Upsert operation - determine if it's insert or update
      const isUpdate = this.cache.has(primaryKey);
      eventType = isUpdate ? RowUpdateType.Update : RowUpdateType.Insert;
      const stored = this.cache.set(row, timestamp);
      if (!stored) {
        this.log.warn('Failed to store row in cache', {
          sourceName: this.schema.sourceName,
          primaryKeyField: this.schema.primaryKeyField,
          rowKeys: Object.keys(row)
        });
        return;
      }
    }
    
    // Log the operation
    const rowData = truncateForLog(row);
    this.log.debug(`Cache updated: ${eventType} - ${rowData}`, {
      sourceName: this.schema.sourceName,
      primaryKey,
      cacheSize: this.cache.size
    });

    // Emit event to subscribers
    const event: RowUpdateEvent & { timestamp: bigint } = {
      type: eventType,
      row: { ...row },
      timestamp
    };
    this.updates$.next(event);
  }

}