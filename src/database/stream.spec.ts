import { DatabaseStream } from './stream.js';
import type { ProtocolHandler } from './types.js';
import { RowUpdateType } from '../common/types.js';
import type { RowUpdateEvent } from '../common/types.js';

// Each pg.Client the stream creates, so tests can drive and inspect it
const pgState = vi.hoisted(() => ({
  clients: [] as {
    config: unknown;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    emit: (event: string, value: unknown) => void;
  }[],
  connect: (): Promise<void> => Promise.resolve(),
}));

vi.mock('pg', () => ({
  default: {
    Client: vi.fn(function (config: unknown) {
      const listeners = new Map<string, (value: unknown) => void>();
      const client = {
        config,
        connect: vi.fn(() => pgState.connect()),
        end: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, listener: (value: unknown) => void) => {
          listeners.set(event, listener);
        }),
        emit: (event: string, value: unknown) => listeners.get(event)?.(value),
      };
      pgState.clients.push(client);
      return client;
    }),
  },
}));

const CONFIG = {
  host: 'localhost',
  port: 6875,
  user: 'materialize',
  password: 'materialize',
  database: 'materialize',
};
const QUERY = { sql: 'select 1', parameters: [] };

const insert = (id: number): RowUpdateEvent => ({
  type: RowUpdateType.Insert,
  fields: new Set(['id']),
  row: { id },
});

// A handler that yields these batches, then either ends or waits forever,
// as Materialize's does on an idle view
const handlerOf = (batches: RowUpdateEvent[][], ends = false) => ({
  read: vi.fn(async function* () {
    for (const batch of batches) {
      yield batch;
    }
    if (!ends) {
      await new Promise(() => {});
    }
  }),
});

const streamOf = (handler: ProtocolHandler) =>
  new DatabaseStream(CONFIG, 'trades', handler, QUERY);

describe('DatabaseStream', () => {
  beforeEach(() => {
    pgState.clients.length = 0;
    pgState.connect = () => Promise.resolve();
  });

  it('should connect, hand the connection and query to the handler, and pass on its batches in order', async () => {
    const handler = handlerOf([[insert(1)], [insert(2)]]);
    const changes = streamOf(handler).read();

    expect((await changes.next()).value).toEqual([insert(1)]);
    expect((await changes.next()).value).toEqual([insert(2)]);

    const [client] = pgState.clients;
    expect(client.connect).toHaveBeenCalled();
    expect(client.config).toEqual(expect.objectContaining(CONFIG));
    expect(handler.read).toHaveBeenCalledWith(client, QUERY);
    await changes.return();
  });

  it('should open nothing until the first pull', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(handlerOf([[insert(1)]])).read({
      onOpen,
      onClose,
    });

    await changes.return();

    expect(pgState.clients).toHaveLength(0);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('should close the connection, once, when the consumer stops on an idle view', async () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    const changes = streamOf(handlerOf([[insert(1)]])).read({
      onOpen,
      onClose,
    });
    await changes.next();

    // Waiting for a batch that never comes
    void changes.next();
    await changes.return();
    await changes.return();

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(pgState.clients[0].end).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('should close the connection when the consumer stops while it is still connecting', async () => {
    pgState.connect = () => new Promise(() => {});
    const handler = handlerOf([[insert(1)]]);
    const onClose = vi.fn();
    const changes = streamOf(handler).read({ onClose });

    void changes.next();
    await changes.return();

    expect(pgState.clients[0].end).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(handler.read).not.toHaveBeenCalled();
  });

  it('should end with the error, and close, when the connection fails', async () => {
    const onClose = vi.fn();
    const changes = streamOf(handlerOf([])).read({ onClose });
    const next = changes.next();
    await vi.waitFor(() => expect(pgState.clients).toHaveLength(1));

    pgState.clients[0].emit('error', new Error('connection reset'));

    await expect(next).rejects.toThrow('connection reset');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(pgState.clients[0].end).toHaveBeenCalled();
  });

  it('should end with the error, and close, when connecting fails', async () => {
    pgState.connect = () => Promise.reject(new Error('ECONNREFUSED'));
    const onClose = vi.fn();
    const changes = streamOf(handlerOf([])).read({ onClose });

    await expect(changes.next()).rejects.toThrow('ECONNREFUSED');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('should end with the error, and close, when the handler fails', async () => {
    const handler: ProtocolHandler = {
      // eslint-disable-next-line require-yield
      read: async function* () {
        throw new Error("the key isn't unique");
      },
    };
    const onClose = vi.fn();
    const changes = streamOf(handler).read({ onClose });

    await expect(changes.next()).rejects.toThrow("the key isn't unique");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(pgState.clients[0].end).toHaveBeenCalled();
  });

  it('should end, and close, when the handler finishes by itself', async () => {
    const onClose = vi.fn();
    const changes = streamOf(handlerOf([[insert(1)]], true)).read({
      onClose,
    });

    expect((await changes.next()).value).toEqual([insert(1)]);
    expect((await changes.next()).done).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
