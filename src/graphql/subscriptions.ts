import { map, tap, of } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import { Logger } from '@nestjs/common';
import { StreamingManagerService } from '../streaming/manager.service';
import type { SourceDefinition } from '../config/source.types';
import type { RowUpdateEvent, Filter } from '../streaming/types';
import { RowUpdateType } from '../streaming/types';
import { truncateForLog } from '../common/logging.utils';
import { buildFilter } from './filters';

/**
 * GraphQL row operation types
 * These map to the values used in the GraphQL schema
 */
export enum GraphQLRowOperation {
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE'
}

/**
 * GraphQL subscription payload structure
 * Contains the operation type, row data, and affected fields
 */
interface GraphQLUpdatePayload {
  [sourceName: string]: {
    operation: GraphQLRowOperation;
    data: Record<string, any> | null;
    fields: string[];
  };
}

/**
 * GraphQL subscription resolver type
 * Defines the subscribe function that returns an async iterator
 */
type SubscriptionResolver = {
  subscribe: (parent: any, args: any, context: any, info: any) => AsyncIterableIterator<GraphQLUpdatePayload>;
};

/**
 * Maps RowUpdateType enum values to GraphQL operation enum values
 */
const ROW_UPDATE_TYPE_MAP = {
  [RowUpdateType.Insert]: GraphQLRowOperation.INSERT,
  [RowUpdateType.Update]: GraphQLRowOperation.UPDATE,
  [RowUpdateType.Delete]: GraphQLRowOperation.DELETE,
} as const;

const logger = new Logger('GraphQLSubscriptions');

/**
 * Creates a subscription resolver for a specific source
 * Returns a GraphQL subscription resolver that streams database updates
 */
function createSourceSubscriptionResolver(
  sourceName: string,
  streamingManager: StreamingManagerService
) {
  return {
    subscribe: (parent: any, args: any, context: any, info: any) => {
      // Parse and compile filter if provided
      const filter = buildFilter(args.where);
      if (filter) {
        logger.log(`Subscription for ${sourceName} with filter: ${filter.expression}`);
      }
      
      // Pass filter to streamingManager if provided
      const observable = streamingManager.getUpdates(sourceName, filter).pipe(
        map((event: RowUpdateEvent) => {
          const operation = ROW_UPDATE_TYPE_MAP[event.type];
          
          // Calculate fields array - always populated for consistency
          const fields: string[] = Object.keys(event.fields);
          
          return {
            [sourceName]: {
              operation,
              data: event.fields, // Use fields instead of row
              fields
            }
          };
        }),
        tap((payload) => {
          const operation = payload[sourceName].operation;
          const data = payload[sourceName].data;
          const fields = payload[sourceName].fields;
          logger.debug(`Sending GraphQL update - source: ${sourceName}, operation: ${operation}, data: ${truncateForLog(data)}${fields ? `, fields: [${fields.join(', ')}]` : ''}`);
        })
      );
      
      return eachValueFrom(observable);
    }
  };
}

/**
 * Builds all subscription resolvers for the given sources
 * Creates a resolver for each source that transforms database events to GraphQL updates
 */
export function buildSubscriptionResolvers(
  sources: Map<string, SourceDefinition>,
  streamingManager: StreamingManagerService
): Record<string, SubscriptionResolver> {
  const resolvers: Record<string, SubscriptionResolver> = {};
  
  sources.forEach((_, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(sourceName, streamingManager);
  });
  
  return resolvers;
}