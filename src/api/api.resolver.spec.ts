import { buildResolvers } from './api.resolver.js';
import { OrderDirection, PostgresType } from '../common/types.js';
import type { ApiService } from './api.service.js';
import { RootType } from './schema.js';
import type { SourceDefinition } from '../config/source.types.js';

const source = (name: string): SourceDefinition => ({
  name,
  primaryKeyField: 'id',
  fields: [{ name: 'id', type: PostgresType.Int4 }],
});

describe('buildResolvers', () => {
  const rows = [{ id: 1 }];
  const updates = {} as AsyncIterableIterator<never>;
  const apiService = {
    query: vi.fn(() => Promise.resolve(rows)),
    subscribe: vi.fn(() => updates),
  } as unknown as ApiService;
  const sources = new Map([
    ['trades', source('trades')],
    ['prices', source('prices')],
  ]);
  const resolvers = buildResolvers(sources, apiService);
  const Query = resolvers[RootType.Query];
  const Subscription = resolvers[RootType.Subscription];
  const where = { id: { _eq: 1 } };
  // A root field's arguments, and the selection they make
  const args = {
    where,
    order_by: [{ id: OrderDirection.Desc }],
    limit: 10,
    offset: 20,
  };
  const selection = {
    where,
    orderBy: [{ id: OrderDirection.Desc }],
    limit: 10,
    offset: 20,
  };

  it('should give every source a query and a subscription, under query_root and subscription_root', () => {
    expect(Object.keys(resolvers)).toEqual(['query_root', 'subscription_root']);
    expect(Object.keys(Query)).toEqual(['trades', 'prices']);
    expect(Object.keys(Subscription)).toEqual(['trades', 'prices']);
  });

  it("should run a source's query with the selection its arguments make, and the request's signal, so a client that leaves ends it", async () => {
    const cancel = new AbortController();

    expect(
      await Query.trades(undefined, args, {
        request: { signal: cancel.signal },
      }),
    ).toBe(rows);
    expect(apiService.query).toHaveBeenCalledWith(
      sources.get('trades'),
      selection,
      cancel.signal,
    );
  });

  it("should hand GraphQL a source's subscription itself, and each timestamp's updates as the field's value", () => {
    expect(Subscription.prices.subscribe(undefined, args)).toBe(updates);
    expect(apiService.subscribe).toHaveBeenCalledWith(
      sources.get('prices'),
      selection,
    );

    const sent = [{ operation: 'INSERT', data: {}, fields: [] }] as never;
    expect(Subscription.prices.resolve(sent)).toBe(sent);
  });
});
