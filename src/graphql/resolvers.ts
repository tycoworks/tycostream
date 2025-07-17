import type { DatabaseStreamer, RowUpdateEvent } from '../database/types.js';
import { logger, truncateForLog } from '../core/logger.js';
import type { StreamerManager } from '../database/streamerManager.js';

interface GraphQLContext {
  streamerManager: StreamerManager;
}

interface SubscriptionResolver {
  subscribe: (_parent: unknown, _args: unknown, context: GraphQLContext) => AsyncGenerator<Record<string, unknown>>;
  resolve: (payload: Record<string, unknown>, _args: unknown, context: GraphQLContext) => unknown;
}

type QueryResolver = (_parent: unknown, _args: unknown, context: GraphQLContext) => Record<string, any>[];

export function createViewSubscriptionResolver(viewName: string): SubscriptionResolver {
  return {
    subscribe: async function* (_parent: unknown, _args: unknown, context: GraphQLContext) {
      const stream = context.streamerManager.getStreamer(viewName);
      if (!stream) {
        throw new Error(`No streamer found for view: ${viewName}`);
      }
      
      for await (const event of stream.getUpdates()) {
        const payload = { [viewName]: event.row };
        logger.debug({
          component: 'graphql-subscription',
          viewName,
          eventType: event.type,
          data: truncateForLog(event.row)
        }, 'Sending subscription update to client');
        yield payload;
      }
    },
    resolve: (payload: Record<string, unknown>) => {
      return payload[viewName];
    },
  };
}

export function createViewQueryResolver(viewName: string): QueryResolver {
  return (_parent: unknown, _args: unknown, context: GraphQLContext) => {
    const stream = context.streamerManager.getStreamer(viewName);
    if (!stream) {
      throw new Error(`No streamer found for view: ${viewName}`);
    }
    
    const rows = stream.getAllRows();
    logger.debug({
      component: 'graphql-query',
      viewName,
      rowCount: rows.length,
      sampleRow: rows.length > 0 ? truncateForLog(rows[0]) : null
    }, 'Sending query response to client');
    return rows;
  };
}