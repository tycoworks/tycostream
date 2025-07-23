import { map, tap } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import { Logger } from '@nestjs/common';
import { DatabaseStreamingManagerService } from '../database/database-streaming-manager.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { RowUpdateEvent } from '../database/types';
import { RowUpdateType } from '../database/types';
import { truncateForLog } from '../common/logging.utils';

interface GraphQLUpdatePayload {
  [sourceName: string]: {
    operation: 'INSERT' | 'UPDATE' | 'DELETE';
    data: Record<string, any> | null;
  };
}

type SubscriptionResolver = {
  subscribe: () => AsyncIterableIterator<GraphQLUpdatePayload>;
};

/**
 * Maps RowUpdateType enum values to GraphQL operation strings
 */
const ROW_UPDATE_TYPE_MAP = {
  [RowUpdateType.Insert]: 'INSERT',
  [RowUpdateType.Update]: 'UPDATE',
  [RowUpdateType.Delete]: 'DELETE',
} as const;

const logger = new Logger('GraphQLSubscriptions');

/**
 * Creates a subscription resolver for a specific source
 */
function createSourceSubscriptionResolver(
  sourceName: string,
  streamingManager: DatabaseStreamingManagerService
) {
  return {
    subscribe: () => {
      const observable = streamingManager.getUpdates(sourceName).pipe(
        map((event: RowUpdateEvent) => {
          return {
            [sourceName]: {
              operation: ROW_UPDATE_TYPE_MAP[event.type],
              data: event.type === RowUpdateType.Delete ? null : event.row,
            }
          };
        }),
        tap((payload) => {
          const operation = payload[sourceName].operation;
          const data = payload[sourceName].data;
          logger.debug(`Sending GraphQL update - source: ${sourceName}, operation: ${operation}, data: ${truncateForLog(data)}`);
        })
      );
      
      return eachValueFrom(observable);
    }
  };
}

/**
 * Builds all subscription resolvers for the given sources
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