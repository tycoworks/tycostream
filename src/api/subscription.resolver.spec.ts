import { of } from 'rxjs';
import { buildSubscriptionResolvers } from './subscription.resolver';
import { SubscriptionService, GraphQLRowOperation } from './subscription.service';
import type { SourceDefinition } from '../config/source.types';

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
  let mockSubscriptionService: jest.Mocked<SubscriptionService>;

  beforeEach(() => {
    mockSubscriptionService = {
      createSubscription: jest.fn(),
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

    const resolvers = buildSubscriptionResolvers(sources, mockSubscriptionService);

    expect(resolvers).toHaveProperty('trades');
    expect(resolvers).toHaveProperty('orders');
    expect(resolvers.trades).toHaveProperty('subscribe');
    expect(typeof resolvers.trades.subscribe).toBe('function');
  });

  it('should return GraphQL operation and data', async () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const mockUpdate = {
      operation: GraphQLRowOperation.INSERT,
      data: { id: 1, symbol: 'AAPL', price: 150 },
      fields: ['id', 'symbol', 'price']
    };

    mockSubscriptionService.createSubscription.mockReturnValue(of(mockUpdate));

    const resolvers = buildSubscriptionResolvers(sources, mockSubscriptionService);
    const asyncIterator = await resolvers.trades.subscribe({}, {}, {}, {});
    
    // Get first value from async iterator
    const { value } = await asyncIterator[Symbol.asyncIterator]().next();
    
    expect(value.trades.operation).toBe('INSERT');
    expect(value.trades.data).toEqual(mockUpdate.data);
  });

  it('should handle all operation types', async () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const testCases = [
      { operation: GraphQLRowOperation.INSERT },
      { operation: GraphQLRowOperation.UPDATE },
      { operation: GraphQLRowOperation.DELETE },
    ];

    for (const testCase of testCases) {
      const mockUpdate = {
        operation: testCase.operation,
        data: { id: 1 },
        fields: ['id']
      };

      mockSubscriptionService.createSubscription.mockReturnValue(of(mockUpdate));
      
      const resolvers = buildSubscriptionResolvers(sources, mockSubscriptionService);
      const asyncIterator = await resolvers.trades.subscribe({}, {}, {}, {});
      
      // Get first value from async iterator
      const { value } = await asyncIterator[Symbol.asyncIterator]().next();
      
      expect(value.trades.operation).toBe(testCase.operation);
    }
  });

  it('should throw error for invalid filter expressions', async () => {
    const sources = new Map<string, SourceDefinition>([
      ['trades', {
        name: 'trades',
        primaryKeyField: 'id',
        fields: [],
      }],
    ]);

    const resolvers = buildSubscriptionResolvers(sources, mockSubscriptionService);
    
    // Mock the service to throw an error for invalid filter
    mockSubscriptionService.createSubscription.mockImplementation(() => {
      throw new Error('Unknown operator: _unknown_op');
    });
    
    const args = {
      where: {
        price: { _unknown_op: 100 }
      }
    };
    
    // Should throw an error when trying to iterate the async generator
    const asyncIterator = await resolvers.trades.subscribe({}, args, {}, {});
    await expect(asyncIterator[Symbol.asyncIterator]().next()).rejects.toThrow('Unknown operator: _unknown_op');
  });
});