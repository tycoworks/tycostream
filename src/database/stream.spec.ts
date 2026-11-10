import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { DatabaseStream } from './stream.js';
import type {
  DatabaseConnectionService,
  ConnectionLease,
} from './connection.service.js';
import type { DatabaseAdapter } from './types.js';
import { RowUpdateType, StreamMode, PostgresType } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { RowUpdateBatch, RowUpdateEvent } from '../common/types.js';

const SELECT = { sql: 'select 1', parameters: [], columns: ['id'] };

const TRADES: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
};

const insert = (id: number): RowUpdateEvent => ({
  type: RowUpdateType.Insert,
  fields: new Set(['id']),
  row: { id },
});

// One complete timestamp's events, as a live stream gives them
const batchAt = (
  timestamp: number,
  ...events: RowUpdateEvent[]
): RowUpdateBatch => ({ timestamp: BigInt(timestamp), events });

// A connection service that lends a fake client, or waits to connect until
// the signal aborts, as the real one does; and records each lease's closing.
// Its time limit can be run out by hand.
const fakeConnectionService = ({ connects = true } = {}) => {
  const client = new EventEmitter() as unknown as pg.ClientBase;
  const timeLimit = new AbortController();
  // Closing ends the connection, which fails a statement in flight
  const close = vi.fn(() => {
    client.emit('end');
    return Promise.resolve();
  });
  const acquire = vi.fn(
    (_mode: StreamMode, signal: AbortSignal): Promise<ConnectionLease> =>
      new Promise((resolve, reject) => {
        const cancel = AbortSignal.any([signal, timeLimit.signal]);
        cancel.addEventListener('abort', () => {
          void close();
          reject(cancel.reason as Error);
        });
        if (connects) {
          resolve({
            client,
            signal: cancel,
            close,
            [Symbol.asyncDispose]: () => close(),
          });
        }
      }),
  );
  return {
    connectionService: { acquire } as unknown as DatabaseConnectionService,
    acquire,
    client,
    close,
    timeLimit,
  };
};

// An adapter that yields these batches, then either ends or, as
// Materialize's does on an idle view, waits until its connection ends
const adapterOf = (batches: RowUpdateBatch[], ends = false) => ({
  read: vi.fn(async function* (client: pg.ClientBase) {
    for (const batch of batches) {
      yield batch;
    }
    if (!ends) {
      await new Promise((_, reject) =>
        client.once('end', () => reject(new Error('Connection terminated'))),
      );
    }
  }),
});

const streamOf = (
  connectionService: DatabaseConnectionService,
  adapter: DatabaseAdapter,
  mode = StreamMode.Live,
) => new DatabaseStream(connectionService, TRADES, mode, adapter, SELECT);

describe('DatabaseStream', () => {
  it('should borrow a subscription connection, hand it, the source, the query and the mode to the adapter, and pass on its batches in order', async () => {
    const { connectionService, acquire, client } = fakeConnectionService();
    const adapter = adapterOf([batchAt(1, insert(1)), batchAt(2, insert(2))]);
    const changes = streamOf(connectionService, adapter).read();

    expect((await changes.next()).value).toEqual(batchAt(1, insert(1)));
    expect((await changes.next()).value).toEqual(batchAt(2, insert(2)));

    expect(acquire).toHaveBeenCalledWith(
      StreamMode.Live,
      expect.any(AbortSignal),
    );
    expect(adapter.read).toHaveBeenCalledWith(
      client,
      TRADES,
      SELECT,
      StreamMode.Live,
    );
    await changes.return();
  });

  it('should borrow nothing until the first pull', async () => {
    const { connectionService, acquire } = fakeConnectionService();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(
      connectionService,
      adapterOf([batchAt(1, insert(1))]),
    ).read({
      onOpen,
      onClose,
    });

    await changes.return();

    expect(acquire).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should cancel the connection, and finish closing before return() resolves, when the consumer stops on an idle view', async () => {
    const { connectionService, acquire, close } = fakeConnectionService();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(
      connectionService,
      adapterOf([batchAt(1, insert(1))]),
    ).read({
      onOpen,
      onClose,
    });
    await changes.next();

    // Waiting for a batch that never comes
    void changes.next();
    await changes.return();

    const signal = acquire.mock.calls[0][1];
    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should cancel the connection when the consumer stops while it is still connecting', async () => {
    const { connectionService, acquire } = fakeConnectionService({
      connects: false,
    });
    const adapter = adapterOf([batchAt(1, insert(1))]);
    const onClose = vi.fn();
    const changes = streamOf(connectionService, adapter).read({ onClose });

    void changes.next();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    await changes.return();

    expect(acquire.mock.calls[0][1].aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(adapter.read).not.toHaveBeenCalled();
  });

  it('should end with the error, and close, when the connection fails', async () => {
    const { connectionService, client, close } = fakeConnectionService();
    const onClose = vi.fn();
    const changes = streamOf(connectionService, adapterOf([])).read({
      onClose,
    });
    const next = changes.next();
    await vi.waitFor(() => expect(client.listenerCount('error')).toBe(1));

    client.emit('error', new Error('connection reset'));

    await expect(next).rejects.toThrow('connection reset');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalled();
  });

  it('should end with the error when borrowing a connection fails', async () => {
    const onClose = vi.fn();
    const connectionService = {
      acquire: () => Promise.reject(new Error('ECONNREFUSED')),
    } as unknown as DatabaseConnectionService;
    const changes = streamOf(connectionService, adapterOf([])).read({
      onClose,
    });

    await expect(changes.next()).rejects.toThrow('ECONNREFUSED');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('should end with the error, and close, when the adapter fails', async () => {
    const { connectionService, close } = fakeConnectionService();
    const adapter: DatabaseAdapter = {
      // eslint-disable-next-line require-yield
      read: async function* () {
        throw new Error("the key isn't unique");
      },
    };
    const onClose = vi.fn();
    const changes = streamOf(connectionService, adapter).read({ onClose });

    await expect(changes.next()).rejects.toThrow("the key isn't unique");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalled();
  });

  it('should end, and close, when the adapter finishes reading by itself', async () => {
    const { connectionService, close } = fakeConnectionService();
    const onClose = vi.fn();
    const changes = streamOf(
      connectionService,
      adapterOf([batchAt(1, insert(1))], true),
    ).read({
      onClose,
    });

    expect((await changes.next()).value).toEqual(batchAt(1, insert(1)));
    expect((await changes.next()).done).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });

  describe('as a snapshot', () => {
    it('should borrow a connection for a snapshot, pass on its one batch, end, and give the connection back for reuse', async () => {
      const { connectionService, acquire, close } = fakeConnectionService();
      const onClose = vi.fn();
      const changes = streamOf(
        connectionService,
        adapterOf([{ events: [insert(1), insert(2)] }], true),
        StreamMode.Snapshot,
      ).read({ onClose });

      expect((await changes.next()).value).toEqual({
        events: [insert(1), insert(2)],
      });
      expect((await changes.next()).done).toBe(true);

      expect(acquire).toHaveBeenCalledWith(
        StreamMode.Snapshot,
        expect.any(AbortSignal),
      );
      expect(close).toHaveBeenCalledWith(undefined);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('should give the connection back with the error when the adapter fails, so it is discarded', async () => {
      const { connectionService, close } = fakeConnectionService();
      const failure = new Error('unknown catalog item');
      const adapter: DatabaseAdapter = {
        // eslint-disable-next-line require-yield
        read: async function* () {
          throw failure;
        },
      };
      const changes = streamOf(
        connectionService,
        adapter,
        StreamMode.Snapshot,
      ).read();

      await expect(changes.next()).rejects.toBe(failure);
      expect(close).toHaveBeenCalledWith(failure);
    });

    it('should fail with why it was cancelled, such as running out of time, not with its connection ending', async () => {
      const { connectionService, timeLimit } = fakeConnectionService();
      const changes = streamOf(
        connectionService,
        adapterOf([]),
        StreamMode.Snapshot,
      ).read();
      const next = changes.next();
      await vi.waitFor(() => expect(timeLimit.signal).toBeDefined());

      const timeout = new DOMException('timed out', 'TimeoutError');
      timeLimit.abort(timeout);

      await expect(next).rejects.toBe(timeout);
    });
  });

  it("should take its error listener off the connection before giving it back, so a reused connection doesn't keep it", async () => {
    const { connectionService, client } = fakeConnectionService();
    const changes = streamOf(
      connectionService,
      adapterOf([batchAt(1, insert(1))], true),
      StreamMode.Snapshot,
    ).read();

    await changes.next();
    await changes.next();

    expect(client.listenerCount('error')).toBe(0);
  });
});
