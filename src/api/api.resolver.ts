import type { SourceDefinition } from '../config/source.types.js';
import type { Row, WhereClause } from '../common/types.js';
import { ApiService, GraphQLUpdate } from './api.service.js';

// Every resolver takes a source's filter
type Args = { where?: WhereClause };

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
 * subscribe returns the updates; resolve gives each one as the field's value
 */
type SubscriptionResolver = {
  subscribe: (
    parent: unknown,
    args: Args,
  ) => AsyncIterableIterator<GraphQLUpdate>;
  resolve: (update: GraphQLUpdate) => GraphQLUpdate;
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
    apiService.query(source, args.where, context.request?.signal);
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
    subscribe: (_parent, args) => apiService.subscribe(source, args.where),
    resolve: (update) => update,
  };
}

/**
 * Builds the resolvers for every source, a query and a subscription each,
 * delegating to ApiService
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): {
  Query: Record<string, QueryResolver>;
  Subscription: Record<string, SubscriptionResolver>;
} {
  const Query: Record<string, QueryResolver> = {};
  const Subscription: Record<string, SubscriptionResolver> = {};

  sources.forEach((source, sourceName) => {
    Query[sourceName] = createQueryResolver(source, apiService);
    Subscription[sourceName] = createSubscriptionResolver(source, apiService);
  });

  return { Query, Subscription };
}
