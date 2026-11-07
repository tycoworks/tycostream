import type pg from 'pg';
import type { RowUpdateEvent } from '../common/types.js';
import type { CompiledQuery } from './query.js';

/**
 * A subscription's row events, one complete timestamp at a time. Ending the
 * iteration closes the subscription.
 */
export interface ChangeBatches extends AsyncIterableIterator<RowUpdateEvent[]> {
  return(): Promise<IteratorResult<RowUpdateEvent[]>>;
}

/**
 * Interface for database-specific protocol implementations
 * Says everything that's said over a subscription's connection, but opens
 * and closes no connections
 */
export interface ProtocolHandler {
  /**
   * Subscribes to the query over an open connection and yields its row
   * events, one complete timestamp at a time, the snapshot first
   */
  read(
    client: pg.ClientBase,
    query: CompiledQuery,
  ): AsyncIterable<RowUpdateEvent[]>;
}
