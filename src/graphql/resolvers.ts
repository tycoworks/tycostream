import type { DatabaseStreamer, RowUpdateEvent } from '../database/types.js';
import { logger, truncateForLog } from '../core/logger.js';

interface GraphQLContext {
  stream: DatabaseStreamer;
  viewName: string;
  primaryKeyField: string;
}

interface SubscriptionResolver {
  subscribe: (_parent: unknown, _args: unknown, context: GraphQLContext) => AsyncGenerator<Record<string, unknown>>;
  resolve: (payload: Record<string, unknown>, _args: unknown, context: GraphQLContext) => unknown;
}

type QueryResolver = (_parent: unknown, _args: unknown, context: GraphQLContext) => Record<string, any>[];

export function createViewSubscriptionResolver(): SubscriptionResolver {
  return {
    subscribe: async function* (_parent: unknown, _args: unknown, context: GraphQLContext) {
      const { stream, viewName } = context;
      
      for await (const event of stream.getUpdates()) {
        const payload = { [viewName]: event.row };
        logger.debug({
          component: 'graphql-subscription',
          viewName,
          eventType: event.type,
          primaryKey: event.row[context.primaryKeyField],
          data: truncateForLog(event.row)
        }, 'Sending subscription update to client');
        yield payload;
      }
    },
    resolve: (payload: Record<string, unknown>, _args: unknown, context: GraphQLContext) => {
      return payload[context.viewName];
    },
  };
}

export function createViewQueryResolver(): QueryResolver {
  return (_parent: unknown, _args: unknown, context: GraphQLContext) => {
    const { stream, viewName } = context;
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