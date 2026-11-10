import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service.js';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseStream } from './stream.js';
import { DatabaseAdapter } from './types.js';
import { StreamMode, PostgresType } from '../common/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { Mock } from 'vitest';

// Mock DatabaseStream: each read() is a stream whose connection opens
// just after, as on a first pull (unless a test says otherwise), and that
// records its close
const streamState = vi.hoisted(() => ({ opens: true }));

vi.mock('./stream.js', () => {
  return {
    DatabaseStream: vi.fn().mockImplementation(function () {
      return {
        read: vi.fn(
          (lifecycle: { onOpen: () => void; onClose: () => void }) => {
            if (streamState.opens) {
              queueMicrotask(lifecycle.onOpen);
            }
            return {
              return: vi.fn(() => {
                lifecycle.onClose();
                return Promise.resolve({ done: true, value: undefined });
              }),
            };
          },
        ),
      };
    }),
  };
});

// Lets the mock streams open
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'symbol', type: PostgresType.Text },
  ],
};

describe('DatabaseService', () => {
  let service: DatabaseService;
  const connectionService = {} as DatabaseConnectionService;
  const adapter = { read: vi.fn() } as unknown as DatabaseAdapter;

  beforeEach(async () => {
    vi.clearAllMocks();
    streamState.opens = true;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: DatabaseConnectionService, useValue: connectionService },
        { provide: DatabaseAdapter, useValue: adapter },
      ],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  describe('stream', () => {
    it.each([StreamMode.Snapshot, StreamMode.Live])(
      'should open a stream of the mode (%s) on the connection service, with the source, the adapter and the compiled filter',
      (mode) => {
        service.stream(trades, { where: { symbol: { _eq: 'AAPL' } } }, mode);

        expect(DatabaseStream).toHaveBeenCalledWith(
          connectionService,
          trades,
          mode,
          adapter,
          expect.objectContaining({
            sql: expect.stringContaining('where "trades"."symbol" = $1'),
            parameters: ['AAPL'],
          }),
        );
      },
    );

    it('should open a separate stream each time', () => {
      const first = service.stream(trades, {}, StreamMode.Live);
      const second = service.stream(trades, {}, StreamMode.Live);

      expect(DatabaseStream).toHaveBeenCalledTimes(2);
      expect(first).not.toBe(second);
    });

    it('should reject an invalid filter without opening a stream', () => {
      expect(() =>
        service.stream(
          trades,
          { where: { no_such_field: { _eq: 1 } } },
          StreamMode.Snapshot,
        ),
      ).toThrow();
      expect(DatabaseStream).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should close every open subscription', async () => {
      const first = service.stream(trades, {}, StreamMode.Live);
      const second = service.stream(trades, {}, StreamMode.Live);
      await flush();

      await service.onModuleDestroy();

      expect(first.return).toHaveBeenCalled();
      expect(second.return).toHaveBeenCalled();
    });

    it('should not close a subscription twice once it has closed itself', async () => {
      const closed = service.stream(trades, {}, StreamMode.Live);
      await flush();
      await closed.return();
      (closed.return as Mock).mockClear();

      await service.onModuleDestroy();

      expect(closed.return).not.toHaveBeenCalled();
    });

    it('should leave alone a subscription that never opened a connection', async () => {
      streamState.opens = false;
      const neverPulled = service.stream(trades, {}, StreamMode.Live);
      await flush();

      await service.onModuleDestroy();

      expect(neverPulled.return).not.toHaveBeenCalled();
    });

    it('should handle no open subscriptions', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
