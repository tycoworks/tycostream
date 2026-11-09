import { Test, TestingModule } from '@nestjs/testing';
import { Repeater } from '@repeaterjs/repeater';
import { ApiService, GraphQLRowOperation } from './api.service.js';
import type { GraphQLUpdate } from './api.service.js';
import { ViewService } from '../view/view.service.js';
import {
  OrderDirection,
  RowUpdateType,
  StreamMode,
  PostgresType,
} from '../common/types.js';
import type { Row, RowUpdateBatch, RowUpdateEvent } from '../common/types.js';
import type { RowUpdateBatches } from '../database/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import type { Mocked } from 'vitest';

describe('ApiService', () => {
  let apiService: ApiService;
  let viewService: Mocked<ViewService>;

  const testSourceDefinition: SourceDefinition = {
    name: 'test_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', type: PostgresType.Text },
      { name: 'name', type: PostgresType.Text },
      { name: 'value', type: PostgresType.Int4 },
    ],
  };
  const ALL_FIELDS = new Set(['id', 'name', 'value']);
  const ROW = { id: '1', name: 'test', value: 7 };

  // A view that sends these timestamps' events, then stays open; records
  // when it's closed
  const viewOf = (...batches: RowUpdateEvent[][]) => {
    const closed = vi.fn();
    const view = new Repeater<RowUpdateBatch>(async (push, stop) => {
      for (const [i, events] of batches.entries()) {
        await push({ timestamp: BigInt(i + 1), events });
      }
      await stop;
      closed();
    });
    viewService.stream.mockReturnValue(view as RowUpdateBatches);
    return closed;
  };

  // A snapshot: these events, then the stream ends
  const snapshotOf = (...batches: RowUpdateEvent[][]) => {
    viewService.stream.mockReturnValue(
      new Repeater<RowUpdateBatch>(async (push, stop) => {
        for (const events of batches) {
          await push({ events });
        }
        stop();
      }) as RowUpdateBatches,
    );
  };

  const take = async (
    updates: AsyncIterableIterator<unknown>,
    count: number,
  ) => {
    const taken: unknown[] = [];
    for (let i = 0; i < count; i++) {
      taken.push((await updates.next()).value);
    }
    return taken;
  };

  beforeEach(async () => {
    viewService = {
      stream: vi.fn(),
    } as unknown as Mocked<ViewService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [ApiService, { provide: ViewService, useValue: viewService }],
    }).compile();

    apiService = module.get<ApiService>(ApiService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('query', () => {
    const insert = (row: Row) => ({
      type: RowUpdateType.Insert,
      fields: ALL_FIELDS,
      row,
    });

    it('should open a snapshot stream on the source and selection', async () => {
      snapshotOf();
      const selection = {
        where: { name: { _eq: 'test' } },
        orderBy: [{ name: OrderDirection.Desc }],
        limit: 5,
      };

      await apiService.query(testSourceDefinition, selection);

      expect(viewService.stream).toHaveBeenCalledWith(
        testSourceDefinition,
        selection,
        StreamMode.Snapshot,
      );
    });

    it('should return the rows in the order the snapshot gives them', async () => {
      snapshotOf([insert({ ...ROW, id: '2' }), insert(ROW)]);

      expect(
        (await apiService.query(testSourceDefinition)).map((row) => row.id),
      ).toEqual(['2', '1']);
    });

    it('should return every row of the snapshot, whole, as GraphQL resolves the fields asked for', async () => {
      snapshotOf([insert(ROW), insert({ ...ROW, id: '2' })]);

      expect(await apiService.query(testSourceDefinition)).toEqual([
        ROW,
        { ...ROW, id: '2' },
      ]);
    });

    it('should return no rows for an empty source', async () => {
      snapshotOf([]);

      expect(await apiService.query(testSourceDefinition)).toEqual([]);
    });

    it('should fail with the error when the view fails', async () => {
      viewService.stream.mockReturnValue(
        new Repeater<RowUpdateBatch>((_push, stop) => {
          void stop(new Error('unknown catalog item'));
        }) as RowUpdateBatches,
      );

      await expect(apiService.query(testSourceDefinition)).rejects.toThrow(
        'unknown catalog item',
      );
    });

    it('should stop the stream, and fail with why, when the signal aborts', async () => {
      // A snapshot that hasn't arrived yet
      const closed = viewOf();
      const cancel = new AbortController();
      const querying = apiService.query(
        testSourceDefinition,
        undefined,
        cancel.signal,
      );

      cancel.abort(new Error('the client left'));

      await expect(querying).rejects.toThrow('the client left');
      expect(closed).toHaveBeenCalled();
    });

    it('should fail when the view rejects the filter', async () => {
      viewService.stream.mockImplementation(() => {
        throw new Error('Unknown field');
      });

      await expect(
        apiService.query(testSourceDefinition, {
          where: { nope: { _eq: 1 } },
        }),
      ).rejects.toThrow('Unknown field');
    });
  });

  describe('subscribe', () => {
    it('should open a live stream on the source and selection', () => {
      viewOf();
      const selection = { where: { name: { _eq: 'test' } }, limit: 5 };

      apiService.subscribe(testSourceDefinition, selection);

      expect(viewService.stream).toHaveBeenCalledWith(
        testSourceDefinition,
        selection,
        StreamMode.Live,
      );
    });

    it('should send an insert with the whole row', async () => {
      viewOf([{ type: RowUpdateType.Insert, fields: ALL_FIELDS, row: ROW }]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([
        [
          {
            operation: GraphQLRowOperation.Insert,
            data: ROW,
            fields: ['id', 'name', 'value'],
          },
        ],
      ]);
    });

    it('should send an update with the key and the changed fields only', async () => {
      viewOf([
        {
          type: RowUpdateType.Update,
          fields: new Set(['id', 'value']),
          row: ROW,
        },
      ]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([
        [
          {
            operation: GraphQLRowOperation.Update,
            data: { id: '1', value: 7 },
            fields: ['id', 'value'],
          },
        ],
      ]);
    });

    it('should send a delete with the key only', async () => {
      viewOf([
        { type: RowUpdateType.Delete, fields: new Set(['id']), row: ROW },
      ]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([
        [
          {
            operation: GraphQLRowOperation.Delete,
            data: { id: '1' },
            fields: ['id'],
          },
        ],
      ]);
    });

    it("should send each timestamp's updates together, as one list, in order", async () => {
      viewOf(
        [
          { type: RowUpdateType.Insert, fields: ALL_FIELDS, row: ROW },
          {
            type: RowUpdateType.Insert,
            fields: ALL_FIELDS,
            row: { ...ROW, id: '2' },
          },
        ],
        [{ type: RowUpdateType.Delete, fields: new Set(['id']), row: ROW }],
      );

      const updates = apiService.subscribe(testSourceDefinition);

      expect(
        ((await take(updates, 2)) as GraphQLUpdate[][]).map((list) =>
          list.map((u) => [u.operation, u.data.id]),
        ),
      ).toEqual([
        [
          [GraphQLRowOperation.Insert, '1'],
          [GraphQLRowOperation.Insert, '2'],
        ],
        [[GraphQLRowOperation.Delete, '1']],
      ]);
    });

    it('should send an empty snapshot as an empty list', async () => {
      viewOf([]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([[]]);
    });

    it('should close the view as soon as the client stops, even while the view is idle', async () => {
      const closed = viewOf([
        { type: RowUpdateType.Insert, fields: ALL_FIELDS, row: ROW },
      ]);
      const updates = apiService.subscribe(testSourceDefinition);
      await take(updates, 1);

      // Waiting for an update that never comes
      void updates.next();
      await updates.return!();

      expect(closed).toHaveBeenCalled();
    });

    it('should end with the error when the view fails', async () => {
      viewService.stream.mockReturnValue(
        new Repeater<RowUpdateBatch>((_push, stop) => {
          void stop(new Error('connection lost'));
        }) as RowUpdateBatches,
      );

      const updates = apiService.subscribe(testSourceDefinition);

      await expect(updates.next()).rejects.toThrow('connection lost');
    });

    it('should throw at once when the view rejects the filter', () => {
      viewService.stream.mockImplementation(() => {
        throw new Error('Unknown field');
      });

      expect(() =>
        apiService.subscribe(testSourceDefinition, {
          where: { nope: { _eq: 1 } },
        }),
      ).toThrow('Unknown field');
    });
  });
});
