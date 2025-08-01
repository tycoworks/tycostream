import { map, tap } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import { Logger } from '@nestjs/common';
import { DatabaseStreamingManagerService } from '../database/database-streaming-manager.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { RowUpdateEvent } from '../database/types';
import { RowUpdateType } from '../database/types';
import { truncateForLog } from '../common/logging.utils';

/**
 * GraphQL row operation types
 * These map to the values used in the GraphQL schema
 */
export enum GraphQLRowOperation {
  INSERT = 'INSERT',
  UPDATE = 'UPDATE',
  DELETE = 'DELETE'
}

interface GraphQLUpdatePayload {
  [sourceName: string]: {
    operation: GraphQLRowOperation;
    data: Record<string, any> | null;
    fields: string[];
  };
}

type SubscriptionResolver = {
  subscribe: () => AsyncIterableIterator<GraphQLUpdatePayload>;
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
  streamingManager: DatabaseStreamingManagerService
) {
  return {
    subscribe: () => {
      const observable = streamingManager.getUpdates(sourceName).pipe(
        map((event: RowUpdateEvent) => {
          const operation = ROW_UPDATE_TYPE_MAP[event.type];
          
          // Calculate fields array - always populated for consistency
          const fields: string[] = Object.keys(event.row);
          
          return {
            [sourceName]: {
              operation,
              data: event.row, // Include row data for all operations, including DELETE
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
  streamingManager: DatabaseStreamingManagerService
): Record<string, SubscriptionResolver> {
  const resolvers: Record<string, SubscriptionResolver> = {};
  
  sources.forEach((_, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(sourceName, streamingManager);
  });
  
  return resolvers;
}