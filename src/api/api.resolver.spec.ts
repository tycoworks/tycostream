import { graphql, parse, subscribe } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { buildResolvers } from './api.resolver.js';
import { OrderDirection, PostgresType } from '../common/types.js';
import type { ApiService } from './api.service.js';
import { RootType, generateSchema } from './schema.js';
import type { SourceDefinition } from '../config/source.types.js';

const source = (name: string): SourceDefinition => ({
  name,
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'symbol', type: PostgresType.Text },
    { name: 'price', type: PostgresType.Numeric },
  ],
});

describe('buildResolvers', () => {
  const rows = [{ id: 1, symbol: 'AAPL', price: 200 }];
  // An idle subscription's updates
  const updates = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: () => new Promise<never>(() => {}),
    return: vi.fn(() => Promise.resolve({ done: true, value: undefined })),
  };
  const apiService = {
    query: vi.fn(() => Promise.resolve(rows)),
    subscribe: vi.fn(() => updates),
  } as unknown as ApiService;
  const sources = new Map([
    ['trades', source('trades')],
    ['prices', source('prices')],
  ]);
  const resolvers = buildResolvers(sources, apiService);
  // The schema the server runs: the generated SDL with these resolvers
  const schema = createSchema({
    typeDefs: generateSchema({ sources, enums: new Map() }),
    resolvers,
  });

  // Runs a query, and gives the selection the source's query ran with
  const queried = async (
    operation: string,
    variableValues?: Record<string, unknown>,
  ) => {
    const result = await graphql({
      schema,
      source: operation,
      variableValues,
      contextValue: {},
    });
    expect(result.errors).toBeUndefined();
    return vi.mocked(apiService.query).mock.lastCall?.[1];
  };

  // Starts a subscription, and gives the selection the source's
  // subscription opened with, and the subscription
  const subscribed = async (operation: string) => {
    const result = await subscribe({ schema, document: parse(operation) });
    expect('errors' in result).toBe(false);
    return {
      selection: vi.mocked(apiService.subscribe).mock.lastCall?.[1],
      subscription: result as AsyncGenerator,
    };
  };

  it('should give every source a query and a subscription, under query_root and subscription_root', () => {
    expect(Object.keys(resolvers)).toEqual(['query_root', 'subscription_root']);
    expect(Object.keys(resolvers[RootType.Query])).toEqual([
      'trades',
      'prices',
    ]);
    expect(Object.keys(resolvers[RootType.Subscription])).toEqual([
      'trades',
      'prices',
    ]);
  });

  describe('queries', () => {
    it("should run a source's query with the selection its fields and arguments make, and the request's signal, so a client that leaves ends it", async () => {
      const cancel = new AbortController();

      const result = await graphql({
        schema,
        source: `{
          trades(where: { id: { _eq: 1 } }, order_by: [{ id: desc }], limit: 10, offset: 20) {
            symbol
          }
        }`,
        contextValue: { request: { signal: cancel.signal } },
      });

      expect(result).toEqual({ data: { trades: [{ symbol: 'AAPL' }] } });
      expect(apiService.query).toHaveBeenCalledWith(
        sources.get('trades'),
        {
          columns: ['symbol'],
          where: { id: { _eq: 1 } },
          orderBy: [{ id: OrderDirection.Desc }],
          limit: 10,
          offset: 20,
        },
        cancel.signal,
      );
    });

    it('should select the fields selected, in order, each once, whatever its aliases', async () => {
      expect(
        await queried('{ trades { a: symbol b: symbol id symbol } }'),
      ).toMatchObject({ columns: ['symbol', 'id'] });
    });

    it("should select fragments' fields, named and inline, and not __typename", async () => {
      expect(
        await queried(`
          { trades { __typename ...named ... on trades { price } } }
          fragment named on trades { symbol }
        `),
      ).toMatchObject({ columns: ['symbol', 'price'] });
    });

    it('should leave out the fields @skip and @include leave out, with literals or variables, on fields and fragments', async () => {
      expect(
        await queried(`{
          trades {
            id @skip(if: true)
            symbol @include(if: false)
            price @include(if: true) @skip(if: false)
          }
        }`),
      ).toMatchObject({ columns: ['price'] });

      const operation = `
        query ($withPrice: Boolean!, $skipNamed: Boolean!) {
          trades { id price @include(if: $withPrice) ...named @skip(if: $skipNamed) }
        }
        fragment named on trades { symbol }
      `;
      expect(
        await queried(operation, { withPrice: false, skipNamed: true }),
      ).toMatchObject({ columns: ['id'] });
      expect(
        await queried(operation, { withPrice: true, skipNamed: false }),
      ).toMatchObject({ columns: ['id', 'price', 'symbol'] });
    });
  });

  describe('subscriptions', () => {
    it("should open a source's subscription with the selection its arguments and its updates' data make, across each time data is selected", async () => {
      const { selection, subscription } = await subscribed(`subscription {
        prices(where: { id: { _eq: 1 } }, limit: 10) {
          operation
          data { id }
          data { symbol }
          fields
        }
      }`);

      expect(selection).toEqual({
        columns: ['id', 'symbol'],
        where: { id: { _eq: 1 } },
        orderBy: undefined,
        limit: 10,
        offset: undefined,
      });
      await subscription.return(undefined);
    });

    it('should select no columns when the updates select no data, or skip it', async () => {
      for (const operation of [
        'subscription { prices { operation } }',
        'subscription { prices { data @skip(if: true) { id } } }',
      ]) {
        const { selection, subscription } = await subscribed(operation);
        expect(selection).toMatchObject({ columns: [] });
        await subscription.return(undefined);
      }
    });

    it("should close the source's subscription at once when the client leaves, so it's handed to GraphQL itself", async () => {
      const { subscription } = await subscribed(
        'subscription { prices { operation } }',
      );
      updates.return.mockClear();

      await subscription.return(undefined);

      expect(updates.return).toHaveBeenCalled();
    });

    it("should give each timestamp's updates as the field's value", () => {
      const sent = [{ operation: 'INSERT', data: {}, fields: [] }] as never;
      expect(resolvers[RootType.Subscription].prices.resolve(sent)).toBe(sent);
    });
  });
});
