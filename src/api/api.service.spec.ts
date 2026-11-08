import { Test, TestingModule } from '@nestjs/testing';
import { Repeater } from '@repeaterjs/repeater';
import { ApiService, GraphQLRowOperation } from './api.service.js';
import { ViewService } from '../view/view.service.js';
import { RowUpdateType, StreamMode } from '../common/types.js';
import type { RowUpdateEvent } from '../common/types.js';
import type { RowUpdateBatches } from '../database/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import type { Mocked } from 'vitest';

describe('ApiService', () => {
  let apiService: ApiService;
  let viewService: Mocked<ViewService>;

  const testSourceDefinition: SourceDefinition = {
    name: 'test_source',
    primaryKeyField: 'id',
    fields: [
      { name: 'id', dataType: DataType.String },
      { name: 'name', dataType: DataType.String },
      { name: 'value', dataType: DataType.Integer },
    ],
  };
  const ALL_FIELDS = new Set(['id', 'name', 'value']);
  const ROW = { id: '1', name: 'test', value: 7 };

  // A view that sends these batches, then stays open; records when it's closed
  const viewOf = (...batches: RowUpdateEvent[][]) => {
    const closed = vi.fn();
    const view = new Repeater<RowUpdateEvent[]>(async (push, stop) => {
      for (const batch of batches) {
        await push(batch);
      }
      await stop;
      closed();
    });
    viewService.stream.mockReturnValue(view as RowUpdateBatches);
    return closed;
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

  describe('subscribe', () => {
    it('should open a live stream on the source and filter', () => {
      viewOf();
      const where = { name: { _eq: 'test' } };

      apiService.subscribe(testSourceDefinition, where);

      expect(viewService.stream).toHaveBeenCalledWith(
        testSourceDefinition,
        where,
        StreamMode.Live,
      );
    });

    it('should send an insert with the whole row', async () => {
      viewOf([{ type: RowUpdateType.Insert, fields: ALL_FIELDS, row: ROW }]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([
        {
          operation: GraphQLRowOperation.Insert,
          data: ROW,
          fields: ['id', 'name', 'value'],
        },
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
        {
          operation: GraphQLRowOperation.Update,
          data: { id: '1', value: 7 },
          fields: ['id', 'value'],
        },
      ]);
    });

    it('should send a delete with the key only', async () => {
      viewOf([
        { type: RowUpdateType.Delete, fields: new Set(['id']), row: ROW },
      ]);

      const updates = apiService.subscribe(testSourceDefinition);

      expect(await take(updates, 1)).toEqual([
        {
          operation: GraphQLRowOperation.Delete,
          data: { id: '1' },
          fields: ['id'],
        },
      ]);
    });

    it('should send every event of every timestamp, in order', async () => {
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
        (
          (await take(updates, 3)) as {
            operation: GraphQLRowOperation;
            data: { id: string };
          }[]
        ).map((u) => [u.operation, u.data.id]),
      ).toEqual([
        [GraphQLRowOperation.Insert, '1'],
        [GraphQLRowOperation.Insert, '2'],
        [GraphQLRowOperation.Delete, '1'],
      ]);
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
        new Repeater<RowUpdateEvent[]>((_push, stop) => {
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
          nope: { _eq: 1 },
        }),
      ).toThrow('Unknown field');
    });
  });
});
