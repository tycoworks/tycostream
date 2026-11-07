import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseService } from './database.service.js';
import { DatabaseConnectionService } from './connection.service.js';
import { DatabaseStream } from './stream.js';
import { DatabaseDriver } from './types.js';
import type { SubscriptionProtocol } from './types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import type { Mock } from 'vitest';

// Mock DatabaseStream: each read() is a subscription whose connection opens
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
    { name: 'id', dataType: DataType.Integer },
    { name: 'symbol', dataType: DataType.String },
  ],
};

describe('DatabaseService', () => {
  let service: DatabaseService;
  const connectionService = {} as DatabaseConnectionService;
  const driver: DatabaseDriver = {
    subscriptions: {} as SubscriptionProtocol,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    streamState.opens = true;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseService,
        { provide: DatabaseConnectionService, useValue: connectionService },
        { provide: DatabaseDriver, useValue: driver },
      ],
    }).compile();

    service = module.get<DatabaseService>(DatabaseService);
  });

  describe('subscribe', () => {
    it("should open a stream on the connection service, with the source, the driver's subscription protocol and the compiled filter", () => {
      service.subscribe(trades, { symbol: { _eq: 'AAPL' } });

      expect(DatabaseStream).toHaveBeenCalledWith(
        connectionService,
        trades,
        driver.subscriptions,
        expect.objectContaining({
          sql: expect.stringContaining('where "symbol" = $1'),
          parameters: ['AAPL'],
        }),
      );
    });

    it('should open a separate stream for each subscription', () => {
      const first = service.subscribe(trades);
      const second = service.subscribe(trades);

      expect(DatabaseStream).toHaveBeenCalledTimes(2);
      expect(first).not.toBe(second);
    });

    it('should reject an invalid filter without opening a stream', () => {
      expect(() =>
        service.subscribe(trades, { no_such_field: { _eq: 1 } }),
      ).toThrow();
      expect(DatabaseStream).not.toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should close every open subscription', async () => {
      const first = service.subscribe(trades);
      const second = service.subscribe(trades);
      await flush();

      await service.onModuleDestroy();

      expect(first.return).toHaveBeenCalled();
      expect(second.return).toHaveBeenCalled();
    });

    it('should not close a subscription twice once it has closed itself', async () => {
      const closed = service.subscribe(trades);
      await flush();
      await closed.return();
      (closed.return as Mock).mockClear();

      await service.onModuleDestroy();

      expect(closed.return).not.toHaveBeenCalled();
    });

    it('should leave alone a subscription that never opened a connection', async () => {
      streamState.opens = false;
      const neverPulled = service.subscribe(trades);
      await flush();

      await service.onModuleDestroy();

      expect(neverPulled.return).not.toHaveBeenCalled();
    });

    it('should handle no open subscriptions', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
