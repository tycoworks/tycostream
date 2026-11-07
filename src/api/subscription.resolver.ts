import type { SourceDefinition } from '../config/source.types.js';
import type { WhereClause } from '../common/types.js';
import { SubscriptionService, GraphQLUpdate } from './subscription.service.js';

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
 * Acts as a thin pass-through to SubscriptionService
 */
function createSourceSubscriptionResolver(
  source: SourceDefinition,
  subscriptionService: SubscriptionService,
): SubscriptionResolver {
  return {
    // Returns the service's iterator itself, not a generator wrapping it, so
    // a client that disconnects closes its subscription at once
    subscribe: (_parent, args) =>
      subscriptionService.subscribe(source, args.where),
    resolve: (update) => update,
  };
}

/**
 * Builds all subscription resolvers for the given sources
 * Creates a resolver for each source that delegates to SubscriptionService
 */
export function buildSubscriptionResolvers(
  sources: Map<string, SourceDefinition>,
  subscriptionService: SubscriptionService,
): Record<string, SubscriptionResolver> {
  const resolvers: Record<string, SubscriptionResolver> = {};

  sources.forEach((source, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(
      source,
      subscriptionService,
    );
  });

  return resolvers;
}
