import { Module } from '@nestjs/common';

@Module({
  providers: [
    // TODO: DatabaseConnectionService
    // TODO: DatabaseStreamingService
    // TODO: StreamBufferService (from buffer.ts)
    // TODO: CacheService (from cache.ts)
    // TODO: MaterializeProtocolHandler (from materialize.ts)
  ],
  exports: [
    // TODO: Export DatabaseStreamingService for GraphQL module
  ],
})
export class DatabaseModule {}