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
  for (const [sourceName, sourceDefinition] of sources) {
    mutationResolvers[`create_${sourceName}_trigger`] = createTriggerMutationResolver(sourceDefinition, triggerService);
    mutationResolvers[`delete_${sourceName}_trigger`] = deleteTriggerMutationResolver(sourceDefinition, triggerService);
    queryResolvers[`${sourceName}_trigger`] = getTriggerQueryResolver(sourceDefinition, triggerService);
    queryResolvers[`${sourceName}_triggers`] = listTriggersQueryResolver(sourceDefinition, triggerService);
  }

  return { mutationResolvers, queryResolvers };
}

/**
 * Creates a resolver for create_${source}_trigger mutation
 */
function createTriggerMutationResolver(
  sourceDefinition: SourceDefinition,
  triggerService: TriggerService
) {
  return async (_: any, args: { input: { name: string; webhook: string; fire: any; clear?: any } }) => {
    logger.log(`Creating ${sourceDefinition.name} trigger: ${args.input.name}`);

    return triggerService.createTrigger(sourceDefinition, {
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
  sourceDefinition: SourceDefinition,
  triggerService: TriggerService
) {
  return async (_: any, args: { name: string }) => {
    logger.log(`Deleting ${sourceDefinition.name} trigger: ${args.name}`);

    return triggerService.deleteTrigger(sourceDefinition, args.name);
  };
}

/**
 * Creates a resolver for ${source}_trigger query
 */
function getTriggerQueryResolver(
  sourceDefinition: SourceDefinition,
  triggerService: TriggerService
) {
  return async (_: any, args: { name: string }) => {
    logger.log(`Getting ${sourceDefinition.name} trigger: ${args.name}`);

    return triggerService.getTrigger(sourceDefinition, args.name);
  };
}

/**
 * Creates a resolver for ${source}_triggers query
 */
function listTriggersQueryResolver(
  sourceDefinition: SourceDefinition,
  triggerService: TriggerService
) {
  return async () => {
    logger.log(`Listing all ${sourceDefinition.name} triggers`);

    return triggerService.listTriggers(sourceDefinition);
  };
}