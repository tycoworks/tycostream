import type { SourceDefinition } from '../config/source.types.js';
import type { WhereClause } from '../common/types.js';
import { ApiService, GraphQLUpdate } from './api.service.js';

/**
 * GraphQL subscription resolver type
 * subscribe returns the updates; resolve gives each one as the field's value
 */
type SubscriptionResolver = {
  subscribe: (
    parent: unknown,
    args: { where?: WhereClause },
  ) => AsyncIterableIterator<GraphQLUpdate>;
  resolve: (update: GraphQLUpdate) => GraphQLUpdate;
};

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
 * Builds the resolvers for every source, each delegating to ApiService
 */
export function buildResolvers(
  sources: Map<string, SourceDefinition>,
  apiService: ApiService,
): { Subscription: Record<string, SubscriptionResolver> } {
  const Subscription: Record<string, SubscriptionResolver> = {};

  sources.forEach((source, sourceName) => {
    Subscription[sourceName] = createSubscriptionResolver(source, apiService);
  });

  return { Subscription };
}
