import { graphql, parse, subscribe } from 'graphql';
import { createSchema } from 'graphql-yoga';
import { buildResolvers } from './api.resolver.js';
import { OrderDirection, PostgresType } from '../common/types.js';
import type { ApiService } from './api.service.js';
import { RootType, generateSchema } from './schema.js';
import type { Relationship, SourceDefinition } from '../config/source.types.js';

// A relationship to the one row of the source a column references
const toOne = (source: SourceDefinition, column: string): Relationship => ({
  source,
  column,
  relatedColumn: source.primaryKeyField,
  many: false,
});

const instruments: SourceDefinition = {
  name: 'instruments',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'name', type: PostgresType.Text },
  ],
};
const positions: SourceDefinition = {
  name: 'positions',
  primaryKeyField: 'instrument_id',
  fields: [
    { name: 'instrument_id', type: PostgresType.Int4 },
    { name: 'symbol', type: PostgresType.Text },
    { name: 'net_position', type: PostgresType.Int8 },
  ],
  relationships: new Map([
    ['instruments', toOne(instruments, 'instrument_id')],
  ]),
};
const trades: SourceDefinition = {
  name: 'trades',
  primaryKeyField: 'id',
  fields: [
    { name: 'id', type: PostgresType.Int4 },
    { name: 'instrument_id', type: PostgresType.Int4 },
    { name: 'quantity', type: PostgresType.Int4 },
    { name: 'price', type: PostgresType.Numeric },
  ],
  relationships: new Map([['positions', toOne(positions, 'instrument_id')]]),
};

describe('buildResolvers', () => {
  const rows = [{ id: 1, instrument_id: 1, quantity: 500, price: 198.4 }];
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
    ['instruments', instruments],
    ['positions', positions],
    ['trades', trades],
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
      'instruments',
      'positions',
      'trades',
    ]);
    expect(Object.keys(resolvers[RootType.Subscription])).toEqual([
      'instruments',
      'positions',
      'trades',
    ]);
  });

  describe('queries', () => {
    it("should run a source's query with the selection its fields and arguments make, and the request's signal, so a client that leaves ends it", async () => {
      const cancel = new AbortController();

      const result = await graphql({
        schema,
        source: `{
          trades(where: { quantity: { _gt: 0 } }, order_by: [{ id: desc }], limit: 10, offset: 20) {
            quantity
            price
          }
        }`,
        contextValue: { request: { signal: cancel.signal } },
      });

      expect(result).toEqual({
        data: { trades: [{ quantity: 500, price: 198.4 }] },
      });
      expect(apiService.query).toHaveBeenCalledWith(
        trades,
        {
          columns: ['quantity', 'price'],
          joins: {},
          where: { quantity: { _gt: 0 } },
          orderBy: [{ id: OrderDirection.Desc }],
          limit: 10,
          offset: 20,
        },
        cancel.signal,
      );
    });

    it('should select the fields selected, in order, each once, whatever its aliases', async () => {
      expect(
        await queried('{ trades { qty: quantity px: price id quantity } }'),
      ).toMatchObject({ columns: ['quantity', 'price', 'id'] });
    });

    it("should select fragments' fields, named and inline, and not __typename", async () => {
      expect(
        await queried(`
          { trades { __typename ...sized ... on trades { price } } }
          fragment sized on trades { quantity }
        `),
      ).toMatchObject({ columns: ['quantity', 'price'] });
    });

    it('should leave out the fields @skip and @include leave out, with literals or variables, on fields and fragments', async () => {
      expect(
        await queried(`{
          trades {
            id @skip(if: true)
            quantity @include(if: false)
            price @include(if: true) @skip(if: false)
          }
        }`),
      ).toMatchObject({ columns: ['price'] });

      const operation = `
        query ($withPrice: Boolean!, $skipSized: Boolean!) {
          trades { id price @include(if: $withPrice) ...sized @skip(if: $skipSized) }
        }
        fragment sized on trades { quantity }
      `;
      expect(
        await queried(operation, { withPrice: false, skipSized: true }),
      ).toMatchObject({ columns: ['id'] });
      expect(
        await queried(operation, { withPrice: true, skipSized: false }),
      ).toMatchObject({ columns: ['id', 'price', 'quantity'] });
    });

    it('should select what each joined row selects, at any depth, across each time it is selected', async () => {
      expect(
        await queried(`{
          trades {
            quantity
            positions { symbol net_position }
            positions { instruments { name } }
          }
        }`),
      ).toEqual(
        expect.objectContaining({
          columns: ['quantity'],
          joins: {
            positions: {
              columns: ['symbol', 'net_position'],
              joins: { instruments: { columns: ['name'], joins: {} } },
            },
          },
        }),
      );
    });
  });

  describe('subscriptions', () => {
    it("should open a source's subscription with the selection its arguments and its updates' data make, across each time data is selected", async () => {
      const { selection, subscription } = await subscribed(`subscription {
        trades(where: { quantity: { _gt: 0 } }, limit: 10) {
          operation
          data { id quantity }
          data { price positions { net_position } }
          fields
        }
      }`);

      expect(selection).toEqual({
        columns: ['id', 'quantity', 'price'],
        joins: { positions: { columns: ['net_position'], joins: {} } },
        where: { quantity: { _gt: 0 } },
        orderBy: undefined,
        limit: 10,
        offset: undefined,
      });
      await subscription.return(undefined);
    });

    it('should select no columns when the updates select no data, or skip it', async () => {
      for (const operation of [
        'subscription { positions { operation } }',
        'subscription { positions { data @skip(if: true) { symbol } } }',
      ]) {
        const { selection, subscription } = await subscribed(operation);
        expect(selection).toMatchObject({ columns: [], joins: {} });
        await subscription.return(undefined);
      }
    });

    it("should close the source's subscription at once when the client leaves, so it's handed to GraphQL itself", async () => {
      const { subscription } = await subscribed(
        'subscription { positions { operation } }',
      );
      updates.return.mockClear();

      await subscription.return(undefined);

      expect(updates.return).toHaveBeenCalled();
    });

    it("should give each timestamp's updates as the field's value", () => {
      const sent = [{ operation: 'INSERT', data: {}, fields: [] }] as never;
      expect(resolvers[RootType.Subscription].positions.resolve(sent)).toBe(
        sent,
      );
    });
  });
});
