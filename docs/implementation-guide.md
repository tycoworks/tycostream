# NestJS Implementation Guide

## Converting Async Iterator to Observable

The key change is converting the `getUpdates()` method from an async iterator to an Observable while preserving the exact late joiner logic.

### Current Implementation (Async Iterator)
```typescript
async *getUpdates(): AsyncIterableIterator<RowUpdateEvent> {
  // 1. Create a replayable tee stream
  const tee$ = new ReplaySubject<RowUpdateEvent>();
  
  // 2. Begin teeing updates into it
  const teeSub = this.updates$.subscribe(event => tee$.next(event));
  
  // 3. Take snapshot and emit rows
  const latestSeenTimestamp = this.latestTimestamp;
  const snapshot = this.cache.getAllRows();
  
  // Emit snapshot as insert events
  for (const row of snapshot) {
    yield {
      type: RowUpdateType.Insert,
      row: { ...row }
    };
  }
  
  // 4. Subscribe to tee$ with filter
  const liveSub = tee$.pipe(
    filter((event: RowUpdateEvent & { timestamp?: bigint }) => {
      return event.timestamp ? event.timestamp > latestSeenTimestamp : true;
    })
  );
  
  // 5. Use rxjs-for-await to convert
  for await (const event of eachValueFrom(liveSub)) {
    yield event;
  }
}
```

### New Implementation (Observable)
```typescript
getUpdates(): Observable<RowUpdateEvent> {
  return new Observable(subscriber => {
    // 1. Capture timestamp BEFORE snapshot (same as before!)
    const snapshotTimestamp = this.latestTimestamp;
    
    // 2. Emit snapshot
    const snapshot = this.cache.getAllRows();
    snapshot.forEach(row => {
      subscriber.next({
        type: RowUpdateType.Insert,
        row: { ...row }
      });
    });
    
    // 3. Subscribe to future updates with timestamp filter
    const updatesSub = this.updates$.pipe(
      filter(event => event.timestamp > snapshotTimestamp)
    ).subscribe(subscriber);
    
    // 4. Start streaming if needed
    if (!this.isStreaming) {
      this.startStreaming();
    }
    
    // 5. Cleanup
    return () => {
      updatesSub.unsubscribe();
      // Note: Don't stop streaming here - shareReplay handles that
    };
  }).pipe(
    shareReplay({
      bufferSize: 0,     // We manage state in cache, not here
      refCount: true     // Start/stop based on active subscribers
    })
  );
}
```

### Why This Preserves Late Joiner Logic

1. **Timestamp Capture**: Still captured BEFORE reading cache
2. **Snapshot Emission**: Each subscriber gets the full cache state
3. **Filtering**: Only events newer than snapshot are included
4. **No Race Conditions**: Same guarantee - no duplicates, no missed events

## File-by-File Migration

### 1. subscriber.ts → database-streaming.service.ts

**Key changes:**
```typescript
// OLD
export class DatabaseSubscriber {
  async *getUpdates(): AsyncIterableIterator<RowUpdateEvent> {
    // Complex async iterator logic
  }
}

// NEW
@Injectable()
export class DatabaseStreamingService {
  getUpdates(): Observable<RowUpdateEvent> {
    // Same logic but returning Observable
  }
}
```

**What stays the same:**
- All the COPY stream handling
- The cache materialization logic
- The timestamp tracking
- The connection management

### 2. Remove rxjs-for-await

**Before:**
```typescript
import { eachValueFrom } from 'rxjs-for-await';

for await (const event of eachValueFrom(liveSub)) {
  yield event;
}
```

**After:**
```typescript
// No import needed - pure RxJS
subscriber.next(event);  // In the Observable constructor
```

### 3. GraphQL Resolver Changes

**Old (with async iterator):**
```typescript
subscribe: async function* (_parent, _args, context) {
  const dbSubscriber = context.subscriberManager.getSubscriber(sourceName);
  for await (const event of dbSubscriber.getUpdates()) {
    yield { [sourceName]: event.row };
  }
}
```

**New (with Observable):**
```typescript
@Subscription(() => Trade)
subscribeTrades(): Observable<any> {
  return this.streamingService.getUpdates().pipe(
    map(event => ({ trade: event.row }))
  );
}
```

## Adding RxJS Filters for GraphQL

Now you can add filters at multiple levels:

```typescript
@Subscription(() => Trade)
tradeUpdates(
  @Args('instrumentId', { type: () => Int, nullable: true }) instrumentId?: number,
  @Args('minPrice', { type: () => Float, nullable: true }) minPrice?: number
): Observable<any> {
  return this.streamingService.getUpdates().pipe(
    // Filter by instrument (if provided)
    filter(event => !instrumentId || event.row.instrument_id === instrumentId),
    
    // Filter by price (if provided)
    filter(event => !minPrice || event.row.price >= minPrice),
    
    // Transform to GraphQL format
    map(event => ({ trade: event.row })),
    
    // Could add more operators:
    // distinctUntilKeyChanged('trade.id'),  // Dedupe by ID
    // throttleTime(100),                     // Rate limit
    // bufferTime(1000, null, 10),           // Batch updates
  );
}
```

## Dependency Injection Setup

### Old Way (Manual)
```typescript
const cache = new SimpleCache(schema.primaryKeyField);
const buffer = new StreamBuffer();
const protocol = new MaterializeProtocolHandler(schema);
const subscriber = new DatabaseSubscriber(config, schema, protocol);
```

### New Way (NestJS DI)
```typescript
@Module({
  providers: [
    // These are now injectable services
    {
      provide: 'CACHE',
      useFactory: (schema: SourceSchema) => new SimpleCache(schema.primaryKeyField),
      inject: ['SOURCE_SCHEMA']
    },
    StreamBufferService,
    {
      provide: 'PROTOCOL',
      useFactory: (schema: SourceSchema) => new MaterializeProtocolHandler(schema),
      inject: ['SOURCE_SCHEMA']
    },
    DatabaseStreamingService
  ]
})
export class DatabaseModule {}
```

## Testing the Observable Approach

```typescript
describe('DatabaseStreamingService', () => {
  it('should handle late joiners correctly', (done) => {
    // Add some initial data
    service.applyOperation({ id: 1, name: 'Test' }, 100n, false);
    
    // First subscriber
    const events1: RowUpdateEvent[] = [];
    const sub1 = service.getUpdates().subscribe(event => {
      events1.push(event);
    });
    
    // Add more data
    service.applyOperation({ id: 2, name: 'Test2' }, 200n, false);
    
    // Late joiner
    const events2: RowUpdateEvent[] = [];
    const sub2 = service.getUpdates().subscribe(event => {
      events2.push(event);
    });
    
    // Late joiner should get snapshot + only new updates
    setTimeout(() => {
      expect(events2.length).toBe(2); // Snapshot of 2 items
      expect(events2[0].type).toBe(RowUpdateType.Insert);
      expect(events2[1].type).toBe(RowUpdateType.Insert);
      
      // Add one more
      service.applyOperation({ id: 3, name: 'Test3' }, 300n, false);
      
      setTimeout(() => {
        expect(events1.length).toBe(3); // All 3
        expect(events2.length).toBe(3); // Snapshot + 1 new
        done();
      }, 10);
    }, 10);
  });
});
```

## Common Patterns

### 1. Multiple Sources
```typescript
@Injectable()
export class StreamingManagerService {
  private streamers = new Map<string, DatabaseStreamingService>();
  
  constructor(
    private moduleRef: ModuleRef,
    private schemaService: SchemaService
  ) {}
  
  async onModuleInit() {
    const schemas = await this.schemaService.getSchemas();
    
    for (const [name, schema] of schemas) {
      const streamer = await this.moduleRef.create(DatabaseStreamingService);
      await streamer.initialize(schema);
      this.streamers.set(name, streamer);
    }
  }
  
  getStreamer(sourceName: string): DatabaseStreamingService {
    return this.streamers.get(sourceName);
  }
}
```

### 2. Error Handling
```typescript
getUpdates(): Observable<RowUpdateEvent> {
  return new Observable(subscriber => {
    // ... setup code ...
  }).pipe(
    shareReplay({ bufferSize: 0, refCount: true }),
    
    // Add error handling
    catchError(error => {
      this.logger.error('Streaming error', error);
      
      // Continue serving from cache only
      return this.getCacheOnlyUpdates();
    }),
    
    // Retry with backoff
    retryWhen(errors =>
      errors.pipe(
        delayWhen((_, i) => timer(Math.min(1000 * Math.pow(2, i), 30000)))
      )
    )
  );
}
```

## Migration Checklist

- [ ] Remove `rxjs-for-await` from package.json
- [ ] Convert `async *getUpdates()` to `getUpdates(): Observable`
- [ ] Add @Injectable() decorators
- [ ] Set up NestJS modules and providers
- [ ] Update GraphQL resolvers to return Observables
- [ ] Test late joiner behavior thoroughly
- [ ] Verify no duplicate events for late joiners
- [ ] Check memory usage with shareReplay