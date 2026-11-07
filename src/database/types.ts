import type pg from 'pg';
import type { RowUpdateEvent } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { CompiledQuery } from './query.js';

/**
 * A subscription's row events, one complete timestamp at a time. Ending the
 * iteration closes the subscription.
 */
export interface RowUpdateBatches extends AsyncIterableIterator<
  RowUpdateEvent[]
> {
  return(): Promise<IteratorResult<RowUpdateEvent[]>>;
}

/**
 * How a database streams a subscription: everything said over the
 * subscription's connection, which it neither opens nor closes. Holds no
 * state, so one serves every subscription.
 */
export interface SubscriptionProtocol {
  /**
   * Subscribes to the source's query over an open connection and yields its
   * row events, one complete timestamp at a time, the snapshot first
   */
  read(
    client: pg.ClientBase,
    source: SourceDefinition,
    query: CompiledQuery,
  ): AsyncIterable<RowUpdateEvent[]>;
}

/**
 * A database's way of doing each kind of work, one protocol per kind.
 * Drivers can share protocols. An abstract class, so it can be injected.
 */
export abstract class DatabaseDriver {
  abstract readonly subscriptions: SubscriptionProtocol;
}
