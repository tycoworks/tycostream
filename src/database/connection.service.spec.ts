import { ConfigService } from '@nestjs/config';
import {
  ConnectionType,
  DatabaseConnectionService,
} from './connection.service.js';

// Each pg.Client made, so tests can drive and inspect it
const pgState = vi.hoisted(() => ({
  clients: [] as {
    config: Record<string, unknown>;
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    emit: (event: string, value: unknown) => void;
  }[],
  connect: (): Promise<void> => Promise.resolve(),
}));

vi.mock('pg', () => ({
  default: {
    Client: vi.fn(function (config: Record<string, unknown>) {
      const listeners = new Map<string, (value: unknown) => void>();
      const client = {
        config,
        connect: vi.fn(() => pgState.connect()),
        end: vi.fn(() => Promise.resolve()),
        on: vi.fn((event: string, listener: (value: unknown) => void) => {
          listeners.set(event, listener);
        }),
        emit: (event: string, value: unknown) => {
          const listener = listeners.get(event);
          if (!listener) {
            // As a real EventEmitter does
            throw value;
          }
          listener(value);
        },
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

const serviceWith = (config: unknown) => {
  const service = new DatabaseConnectionService({
    get: () => config,
  } as unknown as ConfigService);
  service.onModuleInit();
  return service;
};

describe('DatabaseConnectionService', () => {
  let service: DatabaseConnectionService;

  beforeEach(() => {
    pgState.clients.length = 0;
    pgState.connect = () => Promise.resolve();
    service = serviceWith(CONFIG);
  });

  it('should throw on init when database configuration is missing', () => {
    expect(() => serviceWith(undefined)).toThrow(
      'Database configuration not found',
    );
  });

  describe('for a subscription', () => {
    it('should lend a connected connection of its own, with the shared settings and no time limit on reads', async () => {
      const lease = await service.acquire(ConnectionType.Subscription);

      const [client] = pgState.clients;
      expect(lease.client).toBe(client);
      expect(client.connect).toHaveBeenCalled();
      expect(client.config).toEqual(
        expect.objectContaining({
          ...CONFIG,
          keepAlive: true,
          query_timeout: 0,
        }),
      );
    });

    it('should make a new connection for each lease', async () => {
      await service.acquire(ConnectionType.Subscription);
      await service.acquire(ConnectionType.Subscription);

      expect(pgState.clients).toHaveLength(2);
    });

    it('should read every value as text, so the schema decides the types', async () => {
      await service.acquire(ConnectionType.Subscription);

      const { types } = pgState.clients[0].config as {
        types: { getTypeParser: () => (value: string) => unknown };
      };
      expect(types.getTypeParser()('2026-01-01')).toBe('2026-01-01');
    });
  });

  describe('giving a connection back', () => {
    it('should end it on close(), once however often it is closed', async () => {
      const lease = await service.acquire(ConnectionType.Subscription);

      await lease.close();
      await lease.close();

      expect(pgState.clients[0].end).toHaveBeenCalledTimes(1);
    });

    it('should end it at the end of an `await using` scope, even after a throw', async () => {
      await expect(
        (async () => {
          await using lease = await service.acquire(
            ConnectionType.Subscription,
          );
          expect(lease.client).toBeDefined();
          throw new Error('boom');
        })(),
      ).rejects.toThrow('boom');

      expect(pgState.clients[0].end).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelling', () => {
    it('should end the connection when the signal aborts after it is lent', async () => {
      const cancel = new AbortController();
      await service.acquire(ConnectionType.Subscription, cancel.signal);

      cancel.abort();

      await vi.waitFor(() =>
        expect(pgState.clients[0].end).toHaveBeenCalledTimes(1),
      );
    });

    it('should end the connection and reject at once when the signal aborts while connecting', async () => {
      // A connection ended while connecting never settles its connect()
      pgState.connect = () => new Promise(() => {});
      const cancel = new AbortController();
      const lease = service.acquire(ConnectionType.Subscription, cancel.signal);
      await vi.waitFor(() => expect(pgState.clients).toHaveLength(1));

      cancel.abort(new Error('the subscriber left'));

      await expect(lease).rejects.toThrow('the subscriber left');
      expect(pgState.clients[0].end).toHaveBeenCalledTimes(1);
    });

    it('should not connect at all when the signal has already aborted', async () => {
      const cancel = new AbortController();
      cancel.abort(new Error('the subscriber left'));

      await expect(
        service.acquire(ConnectionType.Subscription, cancel.signal),
      ).rejects.toThrow('the subscriber left');
      expect(pgState.clients).toHaveLength(0);
    });
  });

  describe('failures', () => {
    it('should reject, and end the connection, when connecting fails', async () => {
      pgState.connect = () => Promise.reject(new Error('ECONNREFUSED'));

      await expect(
        service.acquire(ConnectionType.Subscription),
      ).rejects.toThrow('ECONNREFUSED');
      expect(pgState.clients[0].end).toHaveBeenCalledTimes(1);
    });

    it('should not let a connection that fails while lent crash the process', async () => {
      await service.acquire(ConnectionType.Subscription);

      expect(() =>
        pgState.clients[0].emit('error', new Error('connection reset')),
      ).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should stop lending once shutdown starts', async () => {
      service.onModuleDestroy();

      await expect(
        service.acquire(ConnectionType.Subscription),
      ).rejects.toThrow('shutting down');
      expect(pgState.clients).toHaveLength(0);
    });
  });
});
