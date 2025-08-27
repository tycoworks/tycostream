import { map, tap, of } from 'rxjs';
import { eachValueFrom } from 'rxjs-for-await';
import { Logger } from '@nestjs/common';
import { ViewService } from '../streaming/view.service';
import { Filter } from '../streaming/filter';
import type { SourceDefinition } from '../config/source.types';
import type { RowUpdateEvent } from '../streaming/types';
import { RowUpdateType } from '../streaming/types';
import { truncateForLog } from '../common/logging.utils';
import { buildExpression } from '../common/expressions';

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
  viewService: ViewService
) {
  return {
    subscribe: (parent: any, args: any, context: any, info: any) => {
      // Parse and compile filter if provided
      const filter = args.where ? new Filter(buildExpression(args.where)) : undefined;
      logger.log(`Subscription for ${sourceName}${filter ? ` with filter: ${filter.match.expression}` : ' (unfiltered)'}`);
      
      // Pass filter to viewService
      const observable = viewService.getUpdates(sourceName, filter).pipe(
        map((event: RowUpdateEvent) => {
          const operation = ROW_UPDATE_TYPE_MAP[event.type];
          
          // Convert Set to array for GraphQL
          const fields: string[] = Array.from(event.fields);
          
          return {
            [sourceName]: {
              operation,
              data: event.row,
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
  viewService: ViewService
): Record<string, SubscriptionResolver> {
  const resolvers: Record<string, SubscriptionResolver> = {};
  
  sources.forEach((_, sourceName) => {
    resolvers[sourceName] = createSourceSubscriptionResolver(sourceName, viewService);
  });
  
  return resolvers;
}