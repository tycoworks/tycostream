import { eachValueFrom } from 'rxjs-for-await';
import { map } from 'rxjs/operators';
import type { SourceDefinition } from '../config/source.types';
import { SubscriptionService, GraphQLUpdate } from './subscription.service';

/**
 * GraphQL subscription payload structure
 * Wraps the update in the source name for GraphQL response
 */
interface GraphQLUpdatePayload {
  [sourceName: string]: GraphQLUpdate;
}

/**
 * GraphQL subscription resolver type
 * Defines the subscribe function that returns an async iterator
 */
type SubscriptionResolver = {
  subscribe: (parent: any, args: any, context: any, info: any) => AsyncIterableIterator<GraphQLUpdatePayload>;
};

/**
 * Creates a subscription resolver for a specific source
 * Acts as a thin pass-through to SubscriptionService
 */
function createSourceSubscriptionResolver(
  sourceDefinition: SourceDefinition,
  subscriptionService: SubscriptionService
): SubscriptionResolver {
  return {
    subscribe: async function* (parent: any, args: any, context: any, info: any) {
      // Create subscription through service
      // GraphQL automatically handles field selection
      const updates$ = subscriptionService.createSubscription(
        sourceDefinition,
        args.where
      ).pipe(
        // Wrap update in source name for GraphQL response structure
        map((update: GraphQLUpdate) => ({
          [sourceDefinition.name]: update
        }))
      );

      // Convert Observable to AsyncIterator for GraphQL
      yield* eachValueFrom(updates$);
    }
  };
}

/**
 * Builds all subscription resolvers for the given sources
 * Creates a resolver for each source that delegates to SubscriptionService
 */
export function buildSubscriptionResolvers(
  sources: Map<string, SourceDefinition>,
  subscriptionService: SubscriptionService
): Record<string, SubscriptionResolver> {
  const resolvers: Record<string, SubscriptionResolver> = {};

  sources.forEach((sourceDefinition, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(sourceDefinition, subscriptionService);
  });

  return resolvers;
}

// Re-export for backward compatibility
export { GraphQLRowOperation } from './subscription.service';