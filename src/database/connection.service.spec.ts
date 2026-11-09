import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { DatabaseConnectionService } from './connection.service.js';
import { StreamMode } from '../common/types.js';
import { TYPE_PARSERS } from './postgres.js';

type FakeClient = EventEmitter & { release: ReturnType<typeof vi.fn> };
type FakePool = EventEmitter & {
  config: Record<string, unknown>;
  connect: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};

// The pool made, and each connection it lends, so tests can drive and
// inspect them. They're EventEmitters, so an 'error' with no listener
// throws, as in pg.
const pgState = vi.hoisted(() => ({
  pools: [] as FakePool[],
  clients: [] as FakeClient[],
  // How the pool hands over a connection; by default at once
  connect: undefined as undefined | (() => Promise<FakeClient>),
}));

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events');
  const newClient = () => {
    const client = Object.assign(new EventEmitter(), {
      release: vi.fn(),
    }) as FakeClient;
    pgState.clients.push(client);
    return client;
  };
  return {
    default: {
      Pool: vi.fn(function (config: Record<string, unknown>) {
        const pool = Object.assign(new EventEmitter(), {
          config,
          connect: vi.fn(() =>
            pgState.connect ? pgState.connect() : Promise.resolve(newClient()),
          ),
          end: vi.fn(() => Promise.resolve()),
        }) as FakePool;
        pgState.pools.push(pool);
        return pool;
      }),
    },
  };
});

const CONFIG = {
  host: 'localhost',
  port: 6875,
  user: 'materialize',
  password: 'materialize',
  database: 'materialize',
  maxConnections: 4,
  queryTimeoutMs: 100,
};
const { maxConnections, queryTimeoutMs, ...CONNECTION } = CONFIG;

const serviceWith = (config: unknown) => {
  const service = new DatabaseConnectionService({
    get: () => config,
  } as unknown as ConfigService);
  service.onModuleInit();
  return service;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DatabaseConnectionService', () => {
  let service: DatabaseConnectionService;

  beforeEach(() => {
    pgState.pools.length = 0;
    pgState.clients.length = 0;
    pgState.connect = undefined;
    service = serviceWith(CONFIG);
  });

  it('should throw on init when database configuration is missing', () => {
    expect(() => serviceWith(undefined)).toThrow(
      'Database configuration not found',
    );
  });

  describe('the pool', () => {
    it('should be made on init, with the shared settings and the cap', () => {
      expect(pgState.pools).toHaveLength(1);
      expect(pgState.pools[0].config).toEqual(
        expect.objectContaining({
          ...CONNECTION,
          keepAlive: true,
          // Also bounds the wait for a free connection
          connectionTimeoutMillis: expect.any(Number),
          max: maxConnections,
        }),
      );
    });

    it("should type every value by its column's type, with tycostream's conversions", () => {
      expect(pgState.pools[0].config).toMatchObject({ types: TYPE_PARSERS });
    });

    it.each([StreamMode.Snapshot, StreamMode.Live])(
      'should lend from it for both modes (%s)',
      async (mode) => {
        const lease = await service.acquire(mode);

        expect(pgState.pools[0].connect).toHaveBeenCalled();
        expect(lease.client).toBe(pgState.clients[0]);
      },
    );
  });

  describe('giving a connection back', () => {
    it("should put a snapshot's connection back in the pool for reuse", async () => {
      const lease = await service.acquire(StreamMode.Snapshot);

      await lease.close();

      expect(pgState.clients[0].release).toHaveBeenCalledWith(false);
    });

    it("should discard a live stream's connection, which drops its SUBSCRIBE", async () => {
      const lease = await service.acquire(StreamMode.Live);

      await lease.close();

      expect(pgState.clients[0].release).toHaveBeenCalledWith(true);
    });

    it('should discard a connection whose work failed', async () => {
      const lease = await service.acquire(StreamMode.Snapshot);

      await lease.close(new Error('unknown catalog item'));

      expect(pgState.clients[0].release).toHaveBeenCalledWith(true);
    });

    it('should give it back once, however often it is closed', async () => {
      const lease = await service.acquire(StreamMode.Snapshot);

      await lease.close();
      await lease.close(new Error('later'));

      expect(pgState.clients[0].release).toHaveBeenCalledTimes(1);
    });

    it('should give it back at the end of an `await using` scope, even after a throw', async () => {
      await expect(
        (async () => {
          await using lease = await service.acquire(StreamMode.Snapshot);
          expect(lease.client).toBeDefined();
          throw new Error('boom');
        })(),
      ).rejects.toThrow('boom');

      expect(pgState.clients[0].release).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancelling', () => {
    it('should discard the connection when the signal aborts while it is lent', async () => {
      const cancel = new AbortController();
      const lease = await service.acquire(StreamMode.Snapshot, cancel.signal);

      cancel.abort(new Error('the client left'));

      expect(pgState.clients[0].release).toHaveBeenCalledWith(true);
      expect(lease.signal.aborted).toBe(true);
      expect(lease.signal.reason).toEqual(new Error('the client left'));
    });

    it('should reject when the signal aborts while it is waiting for a free connection, and give that connection back unused', async () => {
      let handOver!: (client: FakeClient) => void;
      pgState.connect = () => new Promise((resolve) => (handOver = resolve));
      const cancel = new AbortController();
      const lease = service.acquire(StreamMode.Live, cancel.signal);

      cancel.abort(new Error('the client left'));
      const late = Object.assign(new EventEmitter(), { release: vi.fn() });
      handOver(late);

      await expect(lease).rejects.toThrow('the client left');
      expect(late.release).toHaveBeenCalledWith();
    });

    it('should not wait at all when the signal has already aborted', async () => {
      const cancel = new AbortController();
      cancel.abort(new Error('the client left'));

      await expect(
        service.acquire(StreamMode.Live, cancel.signal),
      ).rejects.toThrow('the client left');
      expect(pgState.pools[0].connect).not.toHaveBeenCalled();
    });
  });

  describe('the time limit', () => {
    it("should cancel a snapshot's lease when its time is up, discarding the connection", async () => {
      const lease = await service.acquire(StreamMode.Snapshot);

      await vi.waitFor(() => expect(lease.signal.aborted).toBe(true), {
        timeout: queryTimeoutMs * 10,
      });

      expect((lease.signal.reason as Error).name).toBe('TimeoutError');
      expect(pgState.clients[0].release).toHaveBeenCalledWith(true);
    });

    it('should count waiting for a connection within the time limit', async () => {
      const late = Object.assign(new EventEmitter(), { release: vi.fn() });
      pgState.connect = () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(late), queryTimeoutMs * 2),
        );

      await expect(service.acquire(StreamMode.Snapshot)).rejects.toMatchObject({
        name: 'TimeoutError',
      });
      expect(late.release).toHaveBeenCalledWith();
    });

    it('should give a live stream no time limit', async () => {
      const lease = await service.acquire(StreamMode.Live);

      await sleep(queryTimeoutMs * 2);

      expect(lease.signal.aborted).toBe(false);
      expect(pgState.clients[0].release).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    it('should reject when the pool cannot connect', async () => {
      pgState.connect = () => Promise.reject(new Error('ECONNREFUSED'));

      await expect(service.acquire(StreamMode.Live)).rejects.toThrow(
        'ECONNREFUSED',
      );
    });

    it('should not let a connection that fails, idle in the pool or lent, crash the process', async () => {
      expect(() =>
        pgState.pools[0].emit('error', new Error('connection reset')),
      ).not.toThrow();

      const lease = await service.acquire(StreamMode.Snapshot);
      expect(() =>
        pgState.clients[0].emit('error', new Error('connection reset')),
      ).not.toThrow();

      // Once it's back, the pool's own listener takes over
      await lease.close();
      expect(pgState.clients[0].listenerCount('error')).toBe(0);
    });
  });

  describe('shutdown', () => {
    it('should stop lending once shutdown starts', async () => {
      service.onModuleDestroy();

      for (const mode of [StreamMode.Snapshot, StreamMode.Live]) {
        await expect(service.acquire(mode)).rejects.toThrow('shutting down');
      }
      expect(pgState.pools[0].connect).not.toHaveBeenCalled();
    });

    it('should end the pool last thing at shutdown', async () => {
      await service.onApplicationShutdown();

      expect(pgState.pools[0].end).toHaveBeenCalled();
    });
  });
});
