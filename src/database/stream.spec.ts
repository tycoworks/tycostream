import { EventEmitter } from 'node:events';
import type pg from 'pg';
import { DatabaseStream } from './stream.js';
import { ConnectionType } from './connection.service.js';
import type {
  DatabaseConnectionService,
  ConnectionLease,
} from './connection.service.js';
import type { SubscriptionProtocol } from './types.js';
import { DataType, RowUpdateType } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { RowUpdateEvent } from '../common/types.js';

const QUERY = { sql: 'select 1', parameters: [] };

const TRADES: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [{ name: 'id', dataType: DataType.Integer }],
};

const insert = (id: number): RowUpdateEvent => ({
  type: RowUpdateType.Insert,
  fields: new Set(['id']),
  row: { id },
});

// A connection service that lends a fake client, or waits to connect until the signal
// aborts, as the real ones do; and record each lease's closing
const fakeConnectionService = ({ connects = true } = {}) => {
  const client = new EventEmitter() as unknown as pg.ClientBase;
  // Closing ends the connection, which fails a statement in flight
  const close = vi.fn(() => {
    client.emit('end');
    return Promise.resolve();
  });
  const lease: ConnectionLease = {
    client,
    close,
    [Symbol.asyncDispose]: close,
  };
  const acquire = vi.fn(
    (_type: ConnectionType, signal?: AbortSignal): Promise<ConnectionLease> =>
      new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          void close();
          reject(signal.reason as Error);
        });
        if (connects) {
          resolve(lease);
        }
      }),
  );
  return {
    connectionService: { acquire } as unknown as DatabaseConnectionService,
    acquire,
    client,
    close,
  };
};

// A protocol that yields these batches, then either ends or, as
// Materialize's does on an idle view, waits until its connection ends
const protocolOf = (batches: RowUpdateEvent[][], ends = false) => ({
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
  protocol: SubscriptionProtocol,
) => new DatabaseStream(connectionService, TRADES, protocol, QUERY);

describe('DatabaseStream', () => {
  it('should borrow a subscription connection, hand it, the source and the query to the protocol, and pass on its batches in order', async () => {
    const { connectionService, acquire, client } = fakeConnectionService();
    const protocol = protocolOf([[insert(1)], [insert(2)]]);
    const changes = streamOf(connectionService, protocol).read();

    expect((await changes.next()).value).toEqual([insert(1)]);
    expect((await changes.next()).value).toEqual([insert(2)]);

    expect(acquire).toHaveBeenCalledWith(
      ConnectionType.Subscription,
      expect.any(AbortSignal),
    );
    expect(protocol.read).toHaveBeenCalledWith(client, TRADES, QUERY);
    await changes.return();
  });

  it('should borrow nothing until the first pull', async () => {
    const { connectionService, acquire } = fakeConnectionService();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(connectionService, protocolOf([[insert(1)]])).read(
      {
        onOpen,
        onClose,
      },
    );

    await changes.return();

    expect(acquire).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should cancel the connection, and finish closing before return() resolves, when the consumer stops on an idle view', async () => {
    const { connectionService, acquire, close } = fakeConnectionService();
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(connectionService, protocolOf([[insert(1)]])).read(
      {
        onOpen,
        onClose,
      },
    );
    await changes.next();

    // Waiting for a batch that never comes
    void changes.next();
    await changes.return();

    const signal = acquire.mock.calls[0][1]!;
    expect(signal.aborted).toBe(true);
    expect(close).toHaveBeenCalled();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should cancel the connection when the consumer stops while it is still connecting', async () => {
    const { connectionService, acquire } = fakeConnectionService({
      connects: false,
    });
    const protocol = protocolOf([[insert(1)]]);
    const onClose = vi.fn();
    const changes = streamOf(connectionService, protocol).read({ onClose });

    void changes.next();
    await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
    await changes.return();

    expect(acquire.mock.calls[0][1]!.aborted).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(protocol.read).not.toHaveBeenCalled();
  });

  it('should end with the error, and close, when the connection fails', async () => {
    const { connectionService, client, close } = fakeConnectionService();
    const onClose = vi.fn();
    const changes = streamOf(connectionService, protocolOf([])).read({
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
    const changes = streamOf(connectionService, protocolOf([])).read({
      onClose,
    });

    await expect(changes.next()).rejects.toThrow('ECONNREFUSED');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('should end with the error, and close, when the protocol fails', async () => {
    const { connectionService, close } = fakeConnectionService();
    const protocol: SubscriptionProtocol = {
      // eslint-disable-next-line require-yield
      read: async function* () {
        throw new Error("the key isn't unique");
      },
    };
    const onClose = vi.fn();
    const changes = streamOf(connectionService, protocol).read({ onClose });

    await expect(changes.next()).rejects.toThrow("the key isn't unique");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(close).toHaveBeenCalled();
  });

  it('should end, and close, when the protocol finishes by itself', async () => {
    const { connectionService, close } = fakeConnectionService();
    const onClose = vi.fn();
    const changes = streamOf(
      connectionService,
      protocolOf([[insert(1)]], true),
    ).read({
      onClose,
    });

    expect((await changes.next()).value).toEqual([insert(1)]);
    expect((await changes.next()).done).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalled();
  });
});
