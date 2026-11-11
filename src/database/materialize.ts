import { Injectable } from '@nestjs/common';
import type pg from 'pg';
import { RowUpdateType, StreamMode } from '../common/types.js';
import type { Row, RowUpdateBatch, RowUpdateEvent } from '../common/types.js';
import { insertOf, readSnapshot } from './postgres.js';
import type { RawRow } from './postgres.js';
import type { Statement } from './statement.js';
import { DatabaseAdapter } from './types.js';

/**
 * One row of a live stream's changes: +1 when it was added, -1 when it was
 * removed, and the row's values
 */
export interface DiffRow {
  diff: number;
  row: Row;
}

/**
 * The rows of one complete timestamp
 */
export interface TimestampRows {
  timestamp: bigint;
  rows: DiffRow[];
}

const CURSOR = 'c';

// The columns SUBSCRIBE adds to each row, before the row's own
enum SubscribeColumn {
  Timestamp = 'mz_timestamp',
  Progressed = 'mz_progressed',
  Diff = 'mz_diff',
}

const SUBSCRIBE_COLUMNS: ReadonlySet<string> = new Set(
  Object.values(SubscribeColumn),
);

// A SUBSCRIBE row's own columns: the statement's
function withoutSubscribeColumns(raw: RawRow): RawRow {
  return Object.fromEntries(
    Object.entries(raw).filter(([name]) => !SUBSCRIBE_COLUMNS.has(name)),
  );
}

// FETCH waits until rows exist, so a bigger batch only helps a busy view
const FETCH_SIZE = 1000;

/**
 * Materialize: snapshots as any Postgres-compatible database gives them, and
 * live streams through SUBSCRIBE
 */
@Injectable()
export class MaterializeAdapter extends DatabaseAdapter {
  read(
    client: pg.ClientBase,
    statement: Statement,
  ): AsyncIterable<RowUpdateBatch> {
    return statement.mode === StreamMode.Snapshot
      ? readSnapshot(client, statement)
      : this.readLive(client, statement);
  }

  /**
   * Reads SUBSCRIBE (<statement>) WITH (SNAPSHOT, PROGRESS) through a cursor.
   * Never ends by itself; it stops when the connection closes.
   */
  private async *readLive(
    client: pg.ClientBase,
    statement: Statement,
  ): AsyncGenerator<RowUpdateBatch> {
    // The transaction sits idle while the consumer works through a batch.
    // Materialize's cap on a subscription's backlog limits a slow consumer,
    // so its idle timeout shouldn't
    await client.query('SET idle_in_transaction_session_timeout = 0');
    // A cursor only lives inside a transaction
    await client.query('BEGIN');
    await client.query(
      `DECLARE ${CURSOR} CURSOR FOR SUBSCRIBE (${statement.sql}) WITH (SNAPSHOT, PROGRESS)`,
      [...statement.parameters],
    );

    // FETCH without a timeout returns as soon as rows exist
    const batcher = new ProgressBatcher();
    let snapshot = true;
    while (true) {
      const { rows } = await client.query<RawRow>(
        `FETCH ${FETCH_SIZE} ${CURSOR}`,
      );
      for (const { timestamp, rows: changes } of batcher.take(rows)) {
        const events = pairChanges(
          changes.map(({ diff, row }) => ({
            diff,
            row: statement.unpack(row),
          })),
          statement.source.primaryKeyField,
          statement.columns,
        );
        // The snapshot is sent even when empty; after it, a timestamp whose
        // changes cancel out has nothing to send
        if (snapshot || events.length > 0) {
          yield { timestamp, events };
        }
        snapshot = false;
      }
    }
  }
}

/**
 * Holds a live stream's rows until a progress row says their timestamp is
 * complete, each as the statement gives it, without SUBSCRIBE's own columns
 */
export class ProgressBatcher {
  private readonly pending = new Map<bigint, DiffRow[]>();
  private started = false;

  /**
   * Takes fetched rows and returns each timestamp they complete, oldest
   * first. A progress row at timestamp t means every timestamp before t is
   * complete. The snapshot is at the first timestamp the subscription gives,
   * which Materialize sends first as a progress row, so it's returned even
   * when it has no rows.
   */
  take(rows: RawRow[]): TimestampRows[] {
    const complete: TimestampRows[] = [];
    for (const raw of rows) {
      // Materialize reports mz_timestamp as numeric, so it arrives as a
      // number, which holds its milliseconds exactly
      const timestamp = BigInt(raw[SubscribeColumn.Timestamp] as number);
      if (!this.started) {
        this.pending.set(timestamp, []);
        this.started = true;
      }
      if (raw[SubscribeColumn.Progressed] === true) {
        for (const done of [...this.pending.keys()]
          .filter((t) => t < timestamp)
          .sort((a, b) => (a < b ? -1 : 1))) {
          complete.push({ timestamp: done, rows: this.pending.get(done)! });
          this.pending.delete(done);
        }
      } else {
        const batch = this.pending.get(timestamp) ?? [];
        batch.push({
          diff: Number(raw[SubscribeColumn.Diff]),
          row: withoutSubscribeColumns(raw),
        });
        this.pending.set(timestamp, batch);
      }
    }
    return complete;
  }
}

/**
 * Thrown when a timestamp's rows can't be explained by one row per key,
 * so the declared primary key isn't unique
 */
export class KeyViolationError extends Error {
  constructor(primaryKeyField: string, key: unknown) {
    super(
      `More than one row for ${primaryKeyField} = ${String(key)}: the key isn't unique`,
    );
    this.name = 'KeyViolationError';
  }
}

/**
 * Turns the rows of one complete timestamp into insert, update and delete
 * events. Rows can arrive in any order.
 *
 * - Identical rows are netted first: their diffs are summed, and rows that
 *   come to zero are dropped.
 * - Then, per key: a -1 alone is a delete, a +1 alone is an insert, and a -1
 *   with a +1 is an update of the columns that differ. Anything else means
 *   the key isn't unique.
 *
 * An update's and a delete's `fields` follow RowUpdateEvent: the key plus the
 * changed columns, and the key alone.
 */
export function pairChanges(
  rows: DiffRow[],
  primaryKeyField: string,
  fieldNames: string[],
): RowUpdateEvent[] {
  const byKey = new Map<string, DiffRow[]>();
  for (const netted of netIdenticalRows(rows, fieldNames)) {
    const key = valueKey(netted.row[primaryKeyField]);
    const forKey = byKey.get(key) ?? [];
    forKey.push(netted);
    byKey.set(key, forKey);
  }

  return Array.from(byKey.values()).map((forKey) =>
    toEvent(forKey, primaryKeyField, fieldNames),
  );
}

function toEvent(
  forKey: DiffRow[],
  primaryKeyField: string,
  fieldNames: string[],
): RowUpdateEvent {
  const removed = forKey.find((r) => r.diff === -1);
  const added = forKey.find((r) => r.diff === 1);
  const key = forKey[0].row[primaryKeyField];

  if (forKey.length === 1 && added) {
    return insertOf(added.row, fieldNames);
  }
  if (forKey.length === 1 && removed) {
    return {
      type: RowUpdateType.Delete,
      fields: new Set([primaryKeyField]),
      row: removed.row,
    };
  }
  if (forKey.length === 2 && removed && added) {
    const changed = fieldNames.filter(
      (field) => valueKey(removed.row[field]) !== valueKey(added.row[field]),
    );
    return {
      type: RowUpdateType.Update,
      fields: new Set([primaryKeyField, ...changed]),
      row: added.row,
    };
  }
  throw new KeyViolationError(primaryKeyField, key);
}

// Sums the diffs of identical rows, keeping each row's first appearance
function netIdenticalRows(rows: DiffRow[], fieldNames: string[]): DiffRow[] {
  const netted = new Map<string, DiffRow>();
  for (const { diff, row } of rows) {
    const id = valueKey(fieldNames.map((field) => row[field]));
    const existing = netted.get(id);
    netted.set(id, { diff: (existing?.diff ?? 0) + diff, row });
  }
  return Array.from(netted.values()).filter((r) => r.diff !== 0);
}

// A comparable form of a value, or of a list of them. Every value is plain
// JSON, as the parsers give it, so its JSON compares it, keeping null apart
// from the text 'null'.
function valueKey(value: unknown): string {
  return JSON.stringify(value);
}
