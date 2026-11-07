import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DatabaseStreamService } from './stream.service.js';
import { DatabaseStream } from './stream.js';
import { MaterializeProtocolHandler } from './materialize.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import type { Mock } from 'vitest';

// Mock DatabaseStream: each read() is a subscription that records its close
vi.mock('./stream.js', () => {
  return {
    DatabaseStream: vi.fn().mockImplementation(function () {
      return {
        read: vi.fn((onClosed: () => void) => ({
          return: vi.fn(() => {
            onClosed();
            return Promise.resolve({ done: true, value: undefined });
          }),
        })),
      };
    }),
  };
});

const DB_CONFIG = {
  host: 'localhost',
  port: 6875,
  database: 'materialize',
  user: 'test',
  password: 'test',
};

const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', dataType: DataType.Integer },
    { name: 'symbol', dataType: DataType.String },
  ],
};

describe('DatabaseStreamService', () => {
  let service: DatabaseStreamService;
  let configService: ConfigService;

  beforeEach(async () => {
    vi.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseStreamService,
        {
          provide: ConfigService,
          useValue: { get: vi.fn().mockReturnValue(DB_CONFIG) },
        },
      ],
    }).compile();

    service = module.get<DatabaseStreamService>(DatabaseStreamService);
    configService = module.get<ConfigService>(ConfigService);

    // Config is read in onModuleInit, which compile() doesn't run
    await service.onModuleInit();
  });

  it('should throw on init when database configuration is missing', async () => {
    (configService.get as Mock).mockReturnValue(undefined);
    await expect(service.onModuleInit()).rejects.toThrow(
      'Database configuration not found',
    );
  });

  describe('subscribe', () => {
    it('should open a stream with the config, a Materialize handler and the compiled filter', () => {
      service.subscribe(trades, { symbol: { _eq: 'AAPL' } });

      expect(DatabaseStream).toHaveBeenCalledWith(
        DB_CONFIG,
        'trades',
        expect.any(MaterializeProtocolHandler),
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

      await service.onModuleDestroy();

      expect(first.return).toHaveBeenCalled();
      expect(second.return).toHaveBeenCalled();
    });

    it('should not close a subscription twice once it has closed itself', async () => {
      const closed = service.subscribe(trades);
      await closed.return();
      (closed.return as Mock).mockClear();

      await service.onModuleDestroy();

      expect(closed.return).not.toHaveBeenCalled();
    });

    it('should handle no open subscriptions', async () => {
      await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    });
  });
});
