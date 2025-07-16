import type { DatabaseStreamer } from '../shared/databaseStreamer.js';
import { logger } from '../shared/logger.js';

/**
 * Creates a GraphQL subscription resolver for a view
 */
export function createViewSubscriptionResolver(viewName: string) {
  return {
    subscribe: async function* (_parent: any, _args: any, context: any) {
      const { stream }: { stream: DatabaseStreamer } = context;
      const log = logger.child({ component: 'subscription' });
      
      log.debug('Creating new GraphQL subscription', { viewName });
      
      // Use the async iterator directly from the stream
      for await (const event of stream.getUpdates()) {
        yield { [viewName]: event.row };
      }
    },
    resolve: (payload: any) => payload[viewName],
  };
}

/**
 * Creates a GraphQL query resolver for getting all rows from a view
 */
export function createViewQueryResolver() {
  return (_parent: any, _args: any, context: any) => {
    const { stream }: { stream: DatabaseStreamer } = context;
    return stream.getAllRows();
  };
}