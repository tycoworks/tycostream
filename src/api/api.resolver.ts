import type { SourceDefinition } from '../config/source.types.js';
import type { OrderBy, Row, Selection, WhereClause } from '../common/types.js';
import { ApiService, GraphQLUpdate } from './api.service.js';
import { RootFieldArgument, RootType } from './schema.js';

// Every resolver takes a selection of a source's rows
type Args = {
  [RootFieldArgument.Where]?: WhereClause;
  [RootFieldArgument.OrderBy]?: OrderBy;
  [RootFieldArgument.Limit]?: number;
  [RootFieldArgument.Offset]?: number;
};

// The selection a root field's arguments make
function selectionOf(args: Args): Selection {
  return {
    where: args[RootFieldArgument.Where],
    orderBy: args[RootFieldArgument.OrderBy],
    limit: args[RootFieldArgument.Limit],
    offset: args[RootFieldArgument.Offset],
  };
}

/**
 * The GraphQL context Yoga gives each request. Its request's signal aborts
 * when the client's connection closes before the response has finished.
 */
type Context = { request?: { signal: AbortSignal } };

/**
 * GraphQL query resolver type: a source's current rows, once
 */
type QueryResolver = (
  parent: unknown,
  args: Args,
  context: Context,
) => Promise<Row[]>;

/**
 * GraphQL subscription resolver type
 * subscribe returns each timestamp's updates; resolve gives each list as the
 * field's value
 */
type SubscriptionResolver = {
  subscribe: (
    parent: unknown,
    args: Args,
  ) => AsyncIterableIterator<GraphQLUpdate[]>;
  resolve: (updates: GraphQLUpdate[]) => GraphQLUpdate[];
};

/**
 * Creates a query resolver for a specific source
 * Acts as a thin pass-through to ApiService
 */
function createQueryResolver(
  source: SourceDefinition,
  apiService: ApiService,
): QueryResolver {
  // A client that leaves mid-query ends it in the database
  return (_parent, args, context) =>
    apiService.query(source, selectionOf(args), context.request?.signal);
}

/**
 * Creates a subscription resolver for a specific source
 * Acts as a thin pass-through to ApiService
 */
function createSubscriptionResolver(
  source: SourceDefinition,
  apiService: ApiService,
): SubscriptionResolver {
  return {
    // Returns the service's iterator itself, not a generator wrapping it, so
    // a client that disconnects closes its subscription at once
    subscribe: (_parent, args) =>
      apiService.subscribe(source, selectionOf(args)),
    resolve: (updates) => updates,
  };
}

/**
 * Every source's resolvers, under the root types' names. A type, not an
 * interface, so it fits the GraphQL module's resolver map.
 */
export type Resolvers = {
  [RootType.Query]: Record<string, QueryResolver>;
  [RootType.Subscription]: Record<string, SubscriptionResolver>;
};

/**
 * Builds the resolvers for every source, a query and a subscription each,
 * delegating to ApiService
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): Resolvers {
  const queries: Record<string, QueryResolver> = {};
  const subscriptions: Record<string, SubscriptionResolver> = {};

  sources.forEach((source, sourceName) => {
    queries[sourceName] = createQueryResolver(source, apiService);
    subscriptions[sourceName] = createSubscriptionResolver(source, apiService);
  });

  return {
    [RootType.Query]: queries,
    [RootType.Subscription]: subscriptions,
  };
}
