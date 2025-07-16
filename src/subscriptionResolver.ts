import { Subject } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import type { DatabaseStreamer, RowUpdateEvent } from '../shared/databaseStreamer.js';
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
      
      // Create a Subject to bridge between push (stream) and pull (async iterator)
      const updates$ = new Subject<RowUpdateEvent>();
      
      // Subscribe to the stream
      const unsubscribe = stream.subscribe({
        onUpdate: (event: RowUpdateEvent) => {
          updates$.next(event);
        }
      });
      
      try {
        // Use rxjs-for-await to convert the observable to an async iterable
        for await (const event of eachValueFrom(updates$)) {
          yield { [viewName]: event.row };
        }
      } finally {
        log.debug('Subscription ended, cleaning up', { viewName });
        updates$.complete();
        unsubscribe();
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