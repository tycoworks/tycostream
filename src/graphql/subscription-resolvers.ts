import { map } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import { DatabaseStreamingManagerService } from '../database/database-streaming-manager.service';
import type { SourceDefinition } from '../config/source-definition.types';
import type { RowUpdateEvent } from '../database/types';
import { RowUpdateType } from '../database/types';

/**
 * Maps RowUpdateType enum values to GraphQL operation strings
 */
const ROW_UPDATE_TYPE_MAP = {
  [RowUpdateType.Insert]: 'INSERT',
  [RowUpdateType.Update]: 'UPDATE',
  [RowUpdateType.Delete]: 'DELETE',
} as const;

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
): Record<string, any> {
  const resolvers: Record<string, any> = {};
  
  sources.forEach((_, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(sourceName, streamingManager);
  });
  
  return resolvers;
}