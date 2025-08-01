import { of } from 'rxjs';
import { buildSubscriptionResolvers } from './subscriptions';
import { StreamingManagerService } from '../streaming/manager.service';
import type { SourceDefinition } from '../config/source.types';
import { RowUpdateType } from '../streaming/types';

// Mock rxjs-for-await
jest.mock('rxjs-for-await', () => ({
  eachValueFrom: jest.fn((observable) => {
    // Convert observable to async iterator for tests
    const values: any[] = [];
    observable.subscribe((value: any) => values.push(value));
    
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const value of values) {
          yield value;
        }
      }
    };
  })
}));

describe('buildSubscriptionResolvers', () => {
  let mockStreamingManager: jest.Mocked<StreamingManagerService>;

  beforeEach(() => {
    mockStreamingManager = {
      getUpdates: jest.fn(),
    } as any;
  });

  it('should create resolvers for each source', () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
      ['orders', {
        name: 'orders',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const resolvers = buildSubscriptionResolvers(sources, mockStreamingManager);

    expect(resolvers).toHaveProperty('trades');
    expect(resolvers).toHaveProperty('orders');
    expect(resolvers.trades).toHaveProperty('subscribe');
    expect(typeof resolvers.trades.subscribe).toBe('function');
  });

  it('should map RowUpdateType enum to GraphQL operation strings', async () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const mockEvent = {
      type: RowUpdateType.Insert,
      row: { id: 1, symbol: 'AAPL', price: 150 },
      timestamp: BigInt(1234567890000),
    };

    mockStreamingManager.getUpdates.mockReturnValue(of(mockEvent));

    const resolvers = buildSubscriptionResolvers(sources, mockStreamingManager);
    const asyncIterator = await resolvers.trades.subscribe();
    
    // Get first value from async iterator
    const { value } = await asyncIterator[Symbol.asyncIterator]().next();
    
    expect(value.trades.operation).toBe('INSERT');
    expect(value.trades.data).toEqual(mockEvent.row);
  });

  it('should handle all RowUpdateType values', async () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const testCases = [
      { type: RowUpdateType.Insert, expected: 'INSERT' },
      { type: RowUpdateType.Update, expected: 'UPDATE' },
      { type: RowUpdateType.Delete, expected: 'DELETE' },
    ];

    for (const testCase of testCases) {
      const mockEvent = {
        type: testCase.type,
        row: { id: 1 },
        timestamp: BigInt(1234567890000),
      };

      mockStreamingManager.getUpdates.mockReturnValue(of(mockEvent));
      
      const resolvers = buildSubscriptionResolvers(sources, mockStreamingManager);
      const asyncIterator = await resolvers.trades.subscribe();
      
      // Get first value from async iterator
      const { value } = await asyncIterator[Symbol.asyncIterator]().next();
      
      expect(value.trades.operation).toBe(testCase.expected);
    }
  });
});