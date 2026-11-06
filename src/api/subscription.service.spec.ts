import { Test, TestingModule } from '@nestjs/testing';
import {
  SubscriptionService,
  GraphQLRowOperation,
} from './subscription.service.js';
import { ViewService } from '../view/view.service.js';
import { of } from 'rxjs';
import { RowUpdateType } from '../view/types.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';
import type { Mocked } from 'vitest';

describe('SubscriptionService', () => {
  let subscriptionService: SubscriptionService;
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

  beforeEach(async () => {
    // Minimal mock - just enough to satisfy dependencies
    viewService = {
      getUpdates: vi.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SubscriptionService,
        { provide: ViewService, useValue: viewService },
      ],
    }).compile();

    subscriptionService = module.get<SubscriptionService>(SubscriptionService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('createSubscription', () => {
    it('should create subscription without filter', () =>
      new Promise<void>((done, fail) => {
        const mockEvent = {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name']),
          row: { id: '1', name: 'test' },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        const subscription =
          subscriptionService.createSubscription(testSourceDefinition);

        subscription.subscribe({
          next: (update) => {
            expect(update.operation).toBe(GraphQLRowOperation.Insert);
            expect(update.data).toEqual({ id: '1', name: 'test' });
            expect(update.fields).toEqual(['id', 'name']);
            done();
          },
          error: fail,
        });

        expect(viewService.getUpdates).toHaveBeenCalledWith(
          'test_source',
          undefined,
          true,
        );
      }));

    it('should create subscription with filter', () =>
      new Promise<void>((done, fail) => {
        const mockEvent = {
          type: RowUpdateType.Update,
          fields: new Set(['value']),
          row: { id: '1', name: 'test', value: 150 },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        const whereFilter = { value: { _gt: 100 } };
        const subscription = subscriptionService.createSubscription(
          testSourceDefinition,
          whereFilter,
        );

        subscription.subscribe({
          next: (update) => {
            expect(update.operation).toBe(GraphQLRowOperation.Update);
            expect(update.data).toEqual({ id: '1', name: 'test', value: 150 });
            expect(update.fields).toEqual(['value']);
            done();
          },
          error: fail,
        });

        // Should pass filter to viewService
        expect(viewService.getUpdates).toHaveBeenCalledWith(
          'test_source',
          expect.objectContaining({
            match: expect.objectContaining({
              expression: expect.any(String),
              fields: expect.any(Set),
              evaluate: expect.any(Function),
            }),
          }),
          true,
        );
      }));

    it('should handle INSERT operations', () =>
      new Promise<void>((done) => {
        const mockEvent = {
          type: RowUpdateType.Insert,
          fields: new Set(['id', 'name', 'value']),
          row: { id: '1', name: 'new', value: 100 },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        subscriptionService.createSubscription(testSourceDefinition).subscribe({
          next: (update) => {
            expect(update.operation).toBe(GraphQLRowOperation.Insert);
            expect(update.data).toEqual(mockEvent.row);
            expect(update.fields).toEqual(['id', 'name', 'value']);
            done();
          },
        });
      }));

    it('should handle UPDATE operations', () =>
      new Promise<void>((done) => {
        const mockEvent = {
          type: RowUpdateType.Update,
          fields: new Set(['value']),
          row: { id: '1', name: 'test', value: 200 },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        subscriptionService.createSubscription(testSourceDefinition).subscribe({
          next: (update) => {
            expect(update.operation).toBe(GraphQLRowOperation.Update);
            expect(update.data).toEqual(mockEvent.row);
            expect(update.fields).toEqual(['value']);
            done();
          },
        });
      }));

    it('should handle DELETE operations', () =>
      new Promise<void>((done) => {
        const mockEvent = {
          type: RowUpdateType.Delete,
          fields: new Set(['id']),
          row: { id: '1' },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        subscriptionService.createSubscription(testSourceDefinition).subscribe({
          next: (update) => {
            expect(update.operation).toBe(GraphQLRowOperation.Delete);
            expect(update.data).toEqual(mockEvent.row);
            expect(update.fields).toEqual(['id']);
            done();
          },
        });
      }));

    it('should handle multiple events in sequence', () =>
      new Promise<void>((done) => {
        const events = [
          {
            type: RowUpdateType.Insert,
            fields: new Set(['id', 'name']),
            row: { id: '1', name: 'first' },
          },
          {
            type: RowUpdateType.Update,
            fields: new Set(['name']),
            row: { id: '1', name: 'updated' },
          },
          {
            type: RowUpdateType.Delete,
            fields: new Set(['id']),
            row: { id: '1' },
          },
        ];

        viewService.getUpdates.mockReturnValue(of(...events));

        const updates: any[] = [];
        subscriptionService.createSubscription(testSourceDefinition).subscribe({
          next: (update) => {
            updates.push(update);
            if (updates.length === 3) {
              expect(updates[0].operation).toBe(GraphQLRowOperation.Insert);
              expect(updates[1].operation).toBe(GraphQLRowOperation.Update);
              expect(updates[2].operation).toBe(GraphQLRowOperation.Delete);
              done();
            }
          },
        });
      }));

    it('should preserve field order from Set', () =>
      new Promise<void>((done) => {
        const mockEvent = {
          type: RowUpdateType.Insert,
          fields: new Set(['zebra', 'apple', 'banana']),
          row: { zebra: 'z', apple: 'a', banana: 'b' },
        };

        viewService.getUpdates.mockReturnValue(of(mockEvent));

        subscriptionService.createSubscription(testSourceDefinition).subscribe({
          next: (update) => {
            // Array.from preserves insertion order of Set
            expect(update.fields).toEqual(['zebra', 'apple', 'banana']);
            done();
          },
        });
      }));
  });
});
