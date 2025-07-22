import { Module } from '@nestjs/common';

@Module({
  imports: [
    // TODO: Import DatabaseModule for streaming service
    // TODO: Import SchemaModule for schema definitions
    // TODO: Configure GraphQLModule.forRoot()
  ],
  providers: [
    // TODO: SubscriptionResolver
  ],
})
export class GraphqlModule {}