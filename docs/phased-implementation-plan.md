# Phased Implementation Plan

Each phase builds on the previous one, has visible output, and includes tests.

## Phase 1: Basic NestJS + Config + Logging

**Goal**: Set up NestJS project that loads config and logs it. No database connection yet.

### Steps:
```bash
# 1. Initialize NestJS project
cd /Users/chris.anderson/Development/tycostream
nest new . --skip-git --package-manager npm

# 2. Install dependencies
npm i @nestjs/config class-validator class-transformer
npm i dotenv js-yaml
npm i -D @types/js-yaml

# 3. Copy .env.example from archive
cp ../tycostream-archive/.env.example .env
```

### Files to Create:

**src/config/database.config.ts** (adapted from old config.ts):
```typescript
import { registerAs } from '@nestjs/config';
import { IsString, IsNumber, Min, Max } from 'class-validator';
import { Transform } from 'class-transformer';

export class DatabaseConfiguration {
  @IsString()
  host: string;

  @Transform(({ value }) => parseInt(value, 10))
  @IsNumber()
  @Min(1)
  @Max(65535)
  port: number;

  @IsString()
  user: string;

  @IsString()
  password: string;

  @IsString()
  database: string;
}

export default registerAs('database', (): DatabaseConfiguration => ({
  host: process.env.DATABASE_HOST || 'localhost',
  port: parseInt(process.env.DATABASE_PORT || '6875', 10),
  user: process.env.DATABASE_USER || 'materialize',
  password: process.env.DATABASE_PASSWORD || 'materialize',
  database: process.env.DATABASE_NAME || 'materialize',
}));
```

**src/app.module.ts**:
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import databaseConfig from './config/database.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig],
      envFilePath: '.env',
    }),
  ],
})
export class AppModule {}
```

**src/main.ts**:
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { DatabaseConfiguration } from './config/database.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  
  // Test: Log the config to verify it loads
  const dbConfig = configService.get<DatabaseConfiguration>('database');
  console.log('Database config loaded:', dbConfig);
  
  await app.listen(3000);
}
bootstrap();
```

### Test (src/config/database.config.spec.ts):
```typescript
import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import databaseConfig, { DatabaseConfiguration } from './database.config';

describe('DatabaseConfig', () => {
  let configService: ConfigService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          load: [databaseConfig],
          envFilePath: '.env.test',
        }),
      ],
    }).compile();

    configService = module.get<ConfigService>(ConfigService);
  });

  it('should load database configuration', () => {
    const dbConfig = configService.get<DatabaseConfiguration>('database');
    expect(dbConfig).toBeDefined();
    expect(dbConfig.host).toBeDefined();
    expect(dbConfig.port).toBeGreaterThan(0);
  });
});
```

### Verification:
```bash
npm run start:dev
# Should see: "Database config loaded: { host: 'localhost', port: 6875, ... }"
npm test
```

---

## Phase 2a: Source Definitions Loading

**Goal**: Load source definitions from YAML as part of the configuration system.

### Steps:
```bash
# 1. Copy schema example to project root
cp ../tycostream-archive/config/schema.example.yaml ./schema.yaml

# 2. Install js-yaml
npm install js-yaml
npm install -D @types/js-yaml
```

### Files to Create:

**src/config/source-definition.types.ts**:
```typescript
export interface SourceDefinition {
  name: string;
  primaryKeyField: string;
  fields: SourceField[];
}
```

**src/config/sources.config.ts**:
```typescript
export default registerAs('sources', (): Map<string, SourceDefinition> => {
  // Load YAML file from SCHEMA_PATH env var or ./schema.yaml
  // Parse and validate source definitions
  // Return as a Map
});
```

### Key Changes:
- Source definitions are part of ConfigModule, not a separate module
- YAML file at project root (configurable via SCHEMA_PATH env var)
- Simpler types focused on just source structure, not GraphQL

### Verification:
```bash
npm run start:dev
# Should see: "Loaded 2 source definitions"
```

---

## Phase 2b: Database Connection + Basic Streaming (No Cache)

**Goal**: Connect to database and stream raw data to console. Copy over connection.ts and buffer.ts.

### Files to Add:

**src/database/database.module.ts**:
```typescript
import { Module } from '@nestjs/common';
import { DatabaseConnectionService } from './services/database-connection.service';
import { StreamBufferService } from './services/stream-buffer.service';

@Module({
  providers: [DatabaseConnectionService, StreamBufferService],
  exports: [DatabaseConnectionService, StreamBufferService],
})
export class DatabaseModule {}
```

**src/database/services/database-connection.service.ts** (adapted from connection.ts):
```typescript
// Copy most of connection.ts, just add @Injectable and use ConfigService
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
// ... rest copied from connection.ts with minor adaptations
```

**src/database/services/stream-buffer.service.ts** (copy buffer.ts as-is):
```typescript
// This is almost identical to buffer.ts, just add @Injectable()
import { Injectable } from '@nestjs/common';

@Injectable()
export class StreamBufferService {
  // Copy entire StreamBuffer class content
}
```

**src/test-streaming.ts** (temporary test file):
```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DatabaseConnectionService } from './database/services/database-connection.service';
import { to as copyTo } from 'pg-copy-streams';

async function testStreaming() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const connectionService = app.get(DatabaseConnectionService);
  
  const client = await connectionService.connect();
  
  // Simple COPY to test streaming
  const stream = client.query(copyTo('COPY (SELECT 1 as test) TO STDOUT'));
  
  stream.on('data', (chunk) => {
    console.log('Received chunk:', chunk.toString());
  });
  
  stream.on('end', () => {
    console.log('Stream ended');
    app.close();
  });
}

testStreaming();
```

### Verification:
```bash
npm run build
node dist/test-streaming.js
# Should see raw COPY data if Materialize is running
```

---

## Phase 3: Add Cache + Protocol Handler

**Goal**: Add caching layer and Materialize protocol parsing. Stream parsed data with cache.

### Files to Add:

**src/database/helpers/cache.ts** (copy from cache.ts):
```typescript
// Copy cache.ts exactly as-is
export class SimpleCache {
  // ... existing implementation
}
```

**src/database/protocols/materialize-protocol.ts** (copy from materialize.ts):
```typescript
// Copy materialize.ts with minimal changes
import { Injectable } from '@nestjs/common';
import type { ProtocolHandler } from '../interfaces/types';

@Injectable()
export class MaterializeProtocolHandler implements ProtocolHandler {
  // ... existing implementation
}
```

**src/database/services/basic-streaming.service.ts** (simplified version):
```typescript
@Injectable()
export class BasicStreamingService {
  private cache = new SimpleCache('id'); // Hardcoded for now
  
  async testStreamWithCache() {
    // Connect and stream
    const client = await this.connectionService.connect();
    
    // Parse with protocol handler
    const protocol = new MaterializeProtocolHandler(/* mock schema */);
    
    // Stream and cache
    const stream = client.query(copyTo('COPY (...) TO STDOUT'));
    
    stream.on('data', (chunk) => {
      const lines = this.bufferService.processChunk(chunk);
      lines.forEach(line => {
        const parsed = protocol.parseLine(line);
        if (parsed) {
          // Apply to cache
          this.cache.set(parsed.row);
          console.log('Cached row:', parsed.row);
        }
      });
    });
  }
}
```

### Test:
```typescript
describe('BasicStreamingService', () => {
  it('should cache streamed data', async () => {
    const service = new BasicStreamingService(/* mocked deps */);
    // Test that cache gets populated
  });
});
```

---

## Phase 4: Full DatabaseStreamingService with Observable

**Goal**: Implement the full streaming service with Observable-based late joiner logic.

### Files to Add:

**src/database/services/database-streaming.service.ts**:
```typescript
// This is where we adapt subscriber.ts to use Observables
// Copy the logic but change async iterator to Observable
```

### Test (This is critical):
```typescript
describe('DatabaseStreamingService - Late Joiner Logic', () => {
  let service: DatabaseStreamingService;
  
  it('should handle late joiners without duplicates', (done) => {
    // This test MUST pass - it validates our late joiner logic
    
    // 1. Add initial data
    service.applyOperation({ id: 1 }, 100n, false);
    
    // 2. First subscriber
    const events1: any[] = [];
    service.getUpdates().subscribe(e => events1.push(e));
    
    // 3. Add more data  
    service.applyOperation({ id: 2 }, 200n, false);
    
    // 4. Late joiner
    const events2: any[] = [];
    service.getUpdates().subscribe(e => events2.push(e));
    
    // 5. Verify late joiner gets snapshot + only new
    setTimeout(() => {
      expect(events2).toHaveLength(2); // Snapshot only
      expect(events2[0].row.id).toBe(1);
      expect(events2[1].row.id).toBe(2);
      
      // 6. Add one more
      service.applyOperation({ id: 3 }, 300n, false);
      
      setTimeout(() => {
        expect(events1).toHaveLength(3); // All events
        expect(events2).toHaveLength(3); // Snapshot + 1 new
        done();
      }, 10);
    }, 10);
  });
});
```

---

## Phase 5: Schema Loading + GraphQL

**Goal**: Add YAML schema loading and GraphQL subscriptions.

### Files to Add:

**src/schema/schema.module.ts**:
```typescript
// Adapt schema.ts to NestJS service
```

**src/graphql/graphql.module.ts**:
```typescript
// Set up GraphQL with subscriptions
```

**Copy config directory**:
```bash
cp -r ../tycostream-archive/config .
```

### Test:
```graphql
subscription {
  trades {
    id
    price
  }
}
```

---

## Phase 6: Integration & Cleanup

**Goal**: Full end-to-end working system with all tests passing.

- Remove test files
- Add proper error handling
- Verify all original tests still pass
- Add e2e tests

---

## Key Principles for Each Phase:

1. **Copy code line-by-line where possible** - Especially buffer.ts, cache.ts, protocol parsing
2. **Test the critical parts** - Especially late joiner logic
3. **Visible output** - Each phase should show something working
4. **Incremental complexity** - Start simple, add features gradually
5. **Maintain compatibility** - Same .env, same config format, same GraphQL API