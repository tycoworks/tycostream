import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { createClient, Client as WSClient } from 'graphql-ws';
import * as WebSocket from 'ws';
import { AppModule } from '../src/app.module';
import appConfig from '../src/config/app.config';
import databaseConfig from '../src/config/database.config';
import graphqlConfig from '../src/config/graphql.config';
import sourcesConfig from '../src/config/sources.config';

/**
 * Test configuration options
 */
export interface TestConfig {
  appPort: number;
  schemaPath: string;
  materializeVersion?: string;
  materializeWorkers?: string;
}

/**
 * Test context containing all resources needed for E2E tests
 */
export interface TestContext {
  app: INestApplication;
  materializeContainer: StartedTestContainer;
  pgClient: Client;
  appPort: number;
  materializePort: number;
}

/**
 * Default Materialize container configuration
 */
const DEFAULT_MATERIALIZE_VERSION = 'materialize/materialized:v0.124.0';
const DEFAULT_MATERIALIZE_WORKERS = '1';

/**
 * Create and start a Materialize container for testing
 */
export async function createMaterializeContainer(
  version: string = DEFAULT_MATERIALIZE_VERSION,
  workers: string = DEFAULT_MATERIALIZE_WORKERS
): Promise<StartedTestContainer> {
  return await new GenericContainer(version)
    .withExposedPorts(6875)
    .withEnvironment({
      MZ_WORKERS: workers
    })
    .withStartupTimeout(120000)
    .start();
}

/**
 * Create a PostgreSQL client connected to Materialize
 */
export async function createMaterializeClient(port: number): Promise<Client> {
  const client = new Client({
    host: 'localhost',
    port,
    user: 'materialize',
    database: 'materialize'
  });
  
  await client.connect();
  return client;
}

/**
 * Set up environment variables for test
 */
export function setupTestEnvironment(materializePort: number, appPort: number, schemaPath: string): void {
  process.env.DATABASE_HOST = 'localhost';
  process.env.DATABASE_PORT = materializePort.toString();
  process.env.DATABASE_USER = 'materialize';
  process.env.DATABASE_PASSWORD = 'materialize';
  process.env.DATABASE_NAME = 'materialize';
  process.env.GRAPHQL_PORT = appPort.toString();
  process.env.GRAPHQL_UI = 'false';
  process.env.SCHEMA_PATH = schemaPath;
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
}

/**
 * Create and start NestJS application for testing
 */
export async function createTestApp(config?: { extraProviders?: any[] }): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
  .overrideModule(ConfigModule)
  .useModule(
    ConfigModule.forRoot({
      isGlobal: true,
      cache: false, // Disable cache to pick up env changes
      load: [appConfig, databaseConfig, graphqlConfig, sourcesConfig],
    })
  )
  .compile();

  const app = moduleFixture.createNestApplication();
  return app;
}

/**
 * Bootstrap complete test environment
 */
export async function bootstrapTestEnvironment(config: TestConfig): Promise<TestContext> {
  // Start Materialize container
  const materializeContainer = await createMaterializeContainer(
    config.materializeVersion,
    config.materializeWorkers
  );
  const materializePort = materializeContainer.getMappedPort(6875);
  
  // Create database client
  const pgClient = await createMaterializeClient(materializePort);
  
  // Set up environment
  setupTestEnvironment(materializePort, config.appPort, config.schemaPath);
  
  // Create and start app
  const app = await createTestApp();
  await app.listen(config.appPort);
  
  // Wait for server to stabilize
  await new Promise(resolve => setTimeout(resolve, 1000));
  
  return {
    app,
    materializeContainer,
    pgClient,
    appPort: config.appPort,
    materializePort
  };
}

/**
 * Clean up test environment
 */
export async function cleanupTestEnvironment(context: TestContext): Promise<void> {
  // Close app first
  if (context.app) {
    await context.app.close();
    // Wait for connections to close
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  // Close database connection
  if (context.pgClient) {
    await context.pgClient.end();
  }
  
  // Stop container last
  if (context.materializeContainer) {
    await context.materializeContainer.stop();
  }
}

/**
 * Create a GraphQL WebSocket client
 */
export function createWebSocketClient(port: number): WSClient {
  return createClient({
    url: `ws://localhost:${port}/graphql`,
    webSocketImpl: WebSocket as any,
  });
}

/**
 * Wait for condition with timeout
 */
export async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<void> {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

/**
 * Execute query and wait for Materialize to process
 */
export async function executeAndWait(
  pgClient: Client,
  query: string,
  params?: any[],
  waitMs: number = 100
): Promise<void> {
  await pgClient.query(query, params);
  await new Promise(resolve => setTimeout(resolve, waitMs));
}

/**
 * Type-safe subscription result
 */
export interface SubscriptionEvent<T> {
  data: T;
}

/**
 * Test data builder for predictable test data
 */
export class TestDataBuilder {
  static user(overrides?: Partial<any>): any {
    return {
      user_id: 1,
      name: 'Test User',
      email: 'test@example.com',
      active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {},
      ...overrides
    };
  }
}

/**
 * Collect events from a GraphQL subscription
 */
export function collectSubscriptionEvents(
  client: WSClient,
  query: string,
  eventLimit?: number
): { events: any[]; promise: Promise<void>; unsubscribe: () => void } {
  const events: any[] = [];
  let resolver: () => void;
  let rejecter: (error: any) => void;
  
  const promise = new Promise<void>((resolve, reject) => {
    resolver = resolve;
    rejecter = reject;
  });
  
  const unsubscribe = client.subscribe(
    { query },
    {
      next: (data) => {
        events.push(data);
        if (eventLimit && events.length >= eventLimit) {
          resolver();
        }
      },
      error: (error) => {
        rejecter(error);
      },
      complete: () => {
        resolver();
      }
    }
  );
  
  return { events, promise, unsubscribe };
}