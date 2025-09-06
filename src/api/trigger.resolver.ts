import { Logger } from '@nestjs/common';
import type { SourceDefinition } from '../config/source.types';
import { TriggerService } from './trigger.service';

const logger = new Logger('TriggerResolvers');

/**
 * Builds GraphQL resolvers for trigger operations
 * Generates source-specific mutations and queries dynamically
 */
export function buildTriggerResolvers(
  sources: Map<string, SourceDefinition>,
  triggerService: TriggerService
) {
  const mutationResolvers: Record<string, any> = {};
  const queryResolvers: Record<string, any> = {};

  // Generate source-specific resolvers
  for (const [sourceName] of sources) {
    mutationResolvers[`create_${sourceName}_trigger`] = createTriggerMutationResolver(sourceName, triggerService);
    mutationResolvers[`delete_${sourceName}_trigger`] = deleteTriggerMutationResolver(sourceName, triggerService);
    queryResolvers[`${sourceName}_trigger`] = getTriggerQueryResolver(sourceName, triggerService);
    queryResolvers[`${sourceName}_triggers`] = listTriggersQueryResolver(sourceName, triggerService);
  }

  return { mutationResolvers, queryResolvers };
}

/**
 * Creates a resolver for create_${source}_trigger mutation
 */
function createTriggerMutationResolver(
  sourceName: string,
  triggerService: TriggerService
) {
  return async (_: any, args: { input: { name: string; webhook: string; fire: any; clear?: any } }) => {
    logger.log(`Creating ${sourceName} trigger: ${args.input.name}`);
    
    return triggerService.createTrigger(sourceName, {
      name: args.input.name,
      webhook: args.input.webhook,
      fire: args.input.fire,
      clear: args.input.clear,
    });
  };
}

/**
 * Creates a resolver for delete_${source}_trigger mutation
 */
function deleteTriggerMutationResolver(
  sourceName: string,
  triggerService: TriggerService
) {
  return async (_: any, args: { name: string }) => {
    logger.log(`Deleting ${sourceName} trigger: ${args.name}`);
    
    return triggerService.deleteTrigger(sourceName, args.name);
  };
}

/**
 * Creates a resolver for ${source}_trigger query
 */
function getTriggerQueryResolver(
  sourceName: string,
  triggerService: TriggerService
) {
  return async (_: any, args: { name: string }) => {
    logger.log(`Getting ${sourceName} trigger: ${args.name}`);
    
    return triggerService.getTrigger(sourceName, args.name);
  };
}

/**
 * Creates a resolver for ${source}_triggers query
 */
function listTriggersQueryResolver(
  sourceName: string,
  triggerService: TriggerService
) {
  return async () => {
    logger.log(`Listing all ${sourceName} triggers`);
    
    return triggerService.listTriggers(sourceName);
  };
}