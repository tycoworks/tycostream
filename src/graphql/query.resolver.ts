import { Resolver, Query } from '@nestjs/graphql';

@Resolver()
export class QueryResolver {
  @Query('ping')
  ping(): string {
    return 'pong';
  }
}