# Tycostream NestJS Architecture (Revised)

## Overview

A proper NestJS implementation that uses RxJS Observables throughout, removing async iterators while preserving the critical late joiner logic.

## Why Pure RxJS (No EventEmitter)

You're right to question EventEmitter - since you already moved from EventEmitter to RxJS, let's stay with RxJS throughout:
- **GraphQL filters**: Easy to implement with RxJS operators
- **No dual patterns**: One reactive pattern (RxJS) instead of mixing EventEmitter + RxJS
- **Native to NestJS**: NestJS GraphQL subscriptions expect Observables
- **Better composability**: pipe(), filter(), map() etc. work seamlessly

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          AppModule                                │
├─────────────────┬─────────────────┬──────────────┬──────────────┤
│   ConfigModule  │  DatabaseModule  │ SchemaModule │ GraphQLModule│
│  (@nestjs/config│  (Streaming      │ (YAML loader)│ (Subscription│
│   validation)   │   logic)         │              │  resolvers)  │
└─────────────────┴─────────────────┴──────────────┴──────────────┘
                           │                               ↑
                           │         RxJS Observables       │
                           └───────────────────────────────┘
```

## Module Structure (Properly Idiomatic)

### 1. DatabaseModule

```typescript
@Module({
  providers: [
    // Main services
    DatabaseConnectionService,   // Connection pooling, lifecycle
    DatabaseStreamingService,    // The core subscriber logic, returns Observable
    
    // Supporting services  
    StreamBufferService,        // COPY protocol buffering
    CacheService,              // In-memory state management
    ProtocolFactory,           // Creates protocol handlers (Materialize, future: RisingWave)
  ],
  exports: [DatabaseStreamingService]
})
export class DatabaseModule {}
```

### 2. DatabaseStreamingService (The Key Change)

This replaces the async iterator with a proper Observable while preserving late joiner logic:

```typescript
@Injectable()
export class DatabaseStreamingService implements OnModuleDestroy {
  private updates$ = new Subject<RowUpdateEvent>();
  private cache: CacheService;
  private latestTimestamp = BigInt(0);
  
  constructor(
    private connection: DatabaseConnectionService,
    private buffer: StreamBufferService,
    private cacheFactory: CacheFactory,
    private protocolFactory: ProtocolFactory,
    @Inject('SOURCE_CONFIG') private sourceConfig: SourceSchema
  ) {
    this.cache = this.cacheFactory.create(sourceConfig.primaryKeyField);
  }
  
  /**
   * Returns an Observable that handles late joiners properly
   * This preserves the exact late joiner logic but in Observable form
   */
  getUpdates(): Observable<RowUpdateEvent> {
    return new Observable(subscriber => {
      // 1. Capture the current timestamp (same as before)
      const snapshotTimestamp = this.latestTimestamp;
      
      // 2. Emit the current cache state as Insert events
      const snapshot = this.cache.getAllRows();
      snapshot.forEach(row => {
        subscriber.next({
          type: RowUpdateType.Insert,
          row: { ...row }
        });
      });
      
      // 3. Subscribe to future updates, filtering by timestamp
      const updatesSub = this.updates$.pipe(
        filter(event => event.timestamp > snapshotTimestamp)
      ).subscribe(subscriber);
      
      // 4. Start streaming if needed (one consumer starts for all)
      this.ensureStreaming();
      
      // 5. Cleanup on unsubscribe
      return () => {
        updatesSub.unsubscribe();
      };
    }).pipe(
      // This is the key - shareReplay makes it multicast + late joiner friendly
      shareReplay({
        bufferSize: 0,  // Don't buffer, we handle state in cache
        refCount: true  // Auto start/stop based on subscribers
      })
    );
  }
  
  /**
   * The COPY stream processing - exactly the same logic
   */
  private processChunk(chunk: Buffer): void {
    const lines = this.buffer.processChunk(chunk);
    
    for (const line of lines) {
      const parsed = this.protocol.parseLine(line);
      if (!parsed) continue;
      
      // Same cache-first logic
      this.applyOperation(parsed.row, parsed.timestamp, parsed.isDelete);
    }
  }
  
  /**
   * Cache materialization - EXACTLY the same
   */
  private applyOperation(row: Record<string, any>, timestamp: bigint, isDelete: boolean): void {
    // CRITICAL: Same order - materialize in cache FIRST
    if (isDelete) {
      const deleted = this.cache.delete(row);
      if (!deleted) return;
      eventType = RowUpdateType.Delete;
    } else {
      const isUpdate = this.cache.has(primaryKey);
      eventType = isUpdate ? RowUpdateType.Update : RowUpdateType.Insert;
      const stored = this.cache.set(row);
      if (!stored) return;
    }
    
    // Update timestamp
    this.latestTimestamp = timestamp;
    
    // THEN emit to subscribers
    this.updates$.next({ type: eventType, row, timestamp });
  }
}
```

### 3. GraphQL Subscriptions with Filters

Now you can easily add filters using RxJS operators:

```typescript
@Resolver()
export class SubscriptionResolver {
  constructor(
    private streamingService: DatabaseStreamingService,
    private schemaService: SchemaService
  ) {}
  
  @Subscription(returns => Trade, {
    filter: (payload, variables, context) => {
      // This runs AFTER RxJS operators, as a final filter
      return payload.trade.instrument_id === variables.instrumentId;
    }
  })
  tradeUpdates(
    @Args('instrumentId', { nullable: true }) instrumentId?: number
  ): Observable<any> {
    return this.streamingService.getUpdates().pipe(
      // RxJS filters run first (more efficient)
      filter(event => event.type !== RowUpdateType.Delete),
      
      // Transform to GraphQL response format
      map(event => ({ trade: event.row })),
      
      // You can add more RxJS operators here
      // throttleTime(100), // Throttle updates
      // distinctUntilKeyChanged('trade.price'), // Only emit on price changes
    );
  }
}
```

### 4. Why This Approach Works

1. **Late Joiner Logic Preserved**: The Observable constructor ensures each subscriber gets the snapshot + filtered updates
2. **No rxjs-for-await**: Pure Observables throughout
3. **Efficient Multicasting**: shareReplay ensures one COPY stream serves all subscribers
4. **RxJS Filters**: Full power of RxJS operators for filtering/transformation
5. **Properly Idiomatic**: This is how NestJS apps should handle streaming

### 5. Why Observable Constructor Instead of Subject Patterns

We use `new Observable()` instead of more common Subject patterns because:
- **BehaviorSubject**: Would require complex diffing between states
- **ReplaySubject**: Would replay ALL events (memory issue)  
- **Subject with startWith**: Has race conditions between snapshot and subscription
- **Our approach**: Simple, explicit, and guarantees no missed events or duplicates

This pattern is less common but correct for our specific late joiner requirements.

## What Changes from Current Code

### Major Changes (but same logic):
1. `async *getUpdates()` → `getUpdates(): Observable<RowUpdateEvent>`
2. Remove `rxjs-for-await` dependency entirely
3. GraphQL resolvers return Observables directly

### Minimal Changes:
1. Add @Injectable() decorators
2. Use constructor DI instead of manual instantiation
3. Use ConfigService instead of manual env parsing

### Unchanged:
1. COPY protocol handling (buffer.ts)
2. Cache implementation (cache.ts)
3. Materialize protocol parsing
4. Cache-first materialization logic
5. Timestamp-based filtering for late joiners

## Health Module (Easy to Add Later)

Yes, very easy to add later:

```typescript
// Just add this when ready:
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const isStreaming = this.streamingService.isStreaming();
    const result = this.getStatus(key, isStreaming);
    
    if (isStreaming) {
      return result;
    }
    throw new HealthCheckError('Database streaming unhealthy', result);
  }
}
```

## Summary

This approach:
- Is properly idiomatic NestJS (not just wrapping)
- Removes async iterators completely 
- Uses RxJS throughout (no EventEmitter confusion)
- Preserves the exact late joiner logic
- Enables powerful RxJS-based filtering for GraphQL
- Sets up for future scaling without over-engineering