import { buildResolvers } from './api.resolver.js';
import type { ApiService } from './api.service.js';
import type { SourceDefinition } from '../config/source.types.js';
import { DataType } from '../config/source.types.js';

const source = (name: string): SourceDefinition => ({
  name,
  primaryKeyField: 'id',
  fields: [{ name: 'id', dataType: DataType.Integer }],
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
  const { Query, Subscription } = buildResolvers(sources, apiService);
  const where = { id: { _eq: 1 } };

  it('should give every source a query and a subscription', () => {
    expect(Object.keys(Query)).toEqual(['trades', 'prices']);
    expect(Object.keys(Subscription)).toEqual(['trades', 'prices']);
  });

  it("should run a source's query with its filter and the request's signal, so a client that leaves ends it", async () => {
    const cancel = new AbortController();

    expect(
      await Query.trades(
        undefined,
        { where },
        { request: { signal: cancel.signal } },
      ),
    ).toBe(rows);
    expect(apiService.query).toHaveBeenCalledWith(
      sources.get('trades'),
      where,
      cancel.signal,
    );
  });

  it("should hand GraphQL a source's subscription itself, and each timestamp's updates as the field's value", () => {
    expect(Subscription.prices.subscribe(undefined, { where })).toBe(updates);
    expect(apiService.subscribe).toHaveBeenCalledWith(
      sources.get('prices'),
      where,
    );

    const sent = [{ operation: 'INSERT', data: {}, fields: [] }] as never;
    expect(Subscription.prices.resolve(sent)).toBe(sent);
  });
});
