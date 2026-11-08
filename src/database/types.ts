import type pg from 'pg';
import type { RowUpdateEvent, StreamMode } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { CompiledSelect } from './select.js';

/**
 * A stream's row events, one complete timestamp at a time, the snapshot
 * first. Ending the iteration closes the stream.
 */
export interface RowUpdateBatches extends AsyncIterableIterator<
  RowUpdateEvent[]
> {
  return(): Promise<IteratorResult<RowUpdateEvent[]>>;
}

/**
 * The database: how it reads a stream in either mode, over a connection it
 * neither opens nor closes. Holds no state, so one serves every stream. An
 * abstract class, so it can be injected.
 */
export abstract class DatabaseAdapter {
  /**
   * Runs the source's SELECT over an open connection and yields its row
   * events, one complete timestamp at a time, the snapshot first as inserts.
   * A snapshot then ends; a live read goes on until the connection closes.
   */
  abstract read(
    client: pg.ClientBase,
    source: SourceDefinition,
    select: CompiledSelect,
    mode: StreamMode,
  ): AsyncIterable<RowUpdateEvent[]>;
}
