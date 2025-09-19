import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { ViewService } from '../view/view.service';
import { Filter } from '../view/filter';
import { buildExpression, ExpressionTree } from './expressions';
import { RowUpdateEvent, RowUpdateType } from '../view/types';
import { truncateForLog } from '../common/logging.utils';
import type { SourceConfiguration } from '../config/source.types';

/**
 * GraphQL row operation types
 * These map to the values used in the GraphQL schema
 */
export enum GraphQLRowOperation {
  Insert = 'INSERT',
  Update = 'UPDATE',
  Delete = 'DELETE'
}

/**
 * GraphQL subscription update structure
 */
export interface GraphQLUpdate {
  operation: GraphQLRowOperation;
  data: Record<string, any>;
  fields: string[];
}

/**
 * Maps RowUpdateType enum values to GraphQL operation enum values
 */
const ROW_UPDATE_TYPE_MAP = {
  [RowUpdateType.Insert]: GraphQLRowOperation.Insert,
  [RowUpdateType.Update]: GraphQLRowOperation.Update,
  [RowUpdateType.Delete]: GraphQLRowOperation.Delete,
} as const;

@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);
  private sourceConfig: SourceConfiguration;

  constructor(
    private readonly viewService: ViewService,
    private configService: ConfigService
  ) {
    // Load source configuration once
    this.sourceConfig = this.configService.get<SourceConfiguration>('sources')!;
  }

  /**
   * Creates a subscription stream for a data source
   * Transforms database events into GraphQL updates
   */
  createSubscription(
    sourceName: string,
    where?: ExpressionTree
  ): Observable<GraphQLUpdate> {
    // Get source definition for enum optimization
    const sourceDefinition = this.sourceConfig.sources.get(sourceName);

    // Parse and compile filter if provided, with source definition for enum optimization
    const filter = where ? new Filter(buildExpression(where, sourceDefinition)) : undefined;
    
    this.logger.log(
      `Subscription for ${sourceName}${filter ? ` with filter: ${filter.match.expression}` : ' (unfiltered)'}`
    );

    // Get updates from view service with deltaUpdates enabled for efficiency
    return this.viewService.getUpdates(sourceName, filter, true).pipe(
      map((event: RowUpdateEvent) => this.transformToGraphQLUpdate(event)),
      tap((update) => {
        this.logger.debug(
          `Sending GraphQL update - source: ${sourceName}, operation: ${update.operation}, ` +
          `data: ${truncateForLog(update.data)}, fields: [${update.fields.join(', ')}]`
        );
      })
    );
  }

  /**
   * Transforms a database event into a GraphQL update
   */
  private transformToGraphQLUpdate(event: RowUpdateEvent): GraphQLUpdate {
    const operation = ROW_UPDATE_TYPE_MAP[event.type];
    
    // Convert Set to array for GraphQL
    const fields = Array.from(event.fields);

    return {
      operation,
      data: event.row,
      fields
    };
  }
}