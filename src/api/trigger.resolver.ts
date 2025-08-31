import { Resolver, Query, Mutation, Args } from '@nestjs/graphql';
import { TriggerService } from './trigger.service';

@Resolver('Trigger')
export class TriggerResolver {
  constructor(private readonly triggerService: TriggerService) {}

  @Query('triggers')
  async triggers() {
    return this.triggerService.listTriggers();
  }

  @Query('trigger')
  async trigger(@Args('name') name: string) {
    return this.triggerService.getTrigger(name);
  }

  @Mutation('createTrigger')
  async createTrigger(@Args('input') input: any) {
    return this.triggerService.createTrigger(input);
  }

  @Mutation('deleteTrigger')
  async deleteTrigger(@Args('name') name: string) {
    return this.triggerService.deleteTrigger(name);
  }
}