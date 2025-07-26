import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import appConfig from '../../src/config/app.config';
import databaseConfig from '../../src/config/database.config';
import graphqlConfig from '../../src/config/graphql.config';
import sourcesConfig from '../../src/config/sources.config';

/**
 * Test environment that manages all infrastructure needed for E2E tests
 * Handles database container, connections, and NestJS app lifecycle
 */
export class TestEnvironment {
  private app: INestApplication;
  private databaseContainer: StartedTestContainer;
  private databaseClient: Client;
  private appPort: number;
  private schemaPath: string;
  private databasePort: number;

  private static readonly DATABASE_VERSION = 'materialize/materialized:v0.124.0';
  private static readonly DATABASE_WORKERS = '1';

  constructor(appPort: number, schemaPath: string) {
    this.appPort = appPort;
    this.schemaPath = schemaPath;
  }

  /**
   * Bootstrap the complete test environment
   */
  async setup(): Promise<void> {
    // Start database container
    this.databaseContainer = await this.createDatabaseContainer();
    this.databasePort = this.databaseContainer.getMappedPort(6875);
    
    // Set up environment variables (must be before creating client)
    this.setupEnvironmentVariables();
    
    // Create database client using environment variables
    this.databaseClient = await this.createDatabaseClient();
    
    // Create and start app
    this.app = await this.createTestApp();
    await this.app.listen(this.appPort);
    
    // Wait for server to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  /**
   * Stop and clean up all test resources
   */
  async stop(): Promise<void> {
    // Close app first
    await this.app.close();
    // Wait for connections to close
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Close database connection
    await this.databaseClient.end();
    
    // Stop container last
    await this.databaseContainer.stop();
  }

  /**
   * Execute a SQL query and wait for database to process
   */
  async executeSql(query: string, params?: any[], waitMs: number = 100): Promise<void> {
    await this.databaseClient.query(query, params);
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }


  /**
   * Get the application port
   */
  get port(): number {
    return this.appPort;
  }

  /**
   * Wait for a condition to be true
   */
  async waitUntil(
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
   * Static factory method to create and setup a test environment
   */
  static async create(appPort: number, schemaPath: string): Promise<TestEnvironment> {
    const env = new TestEnvironment(appPort, schemaPath);
    await env.setup();
    return env;
  }

  /**
   * Create and start a database container
   */
  private async createDatabaseContainer(): Promise<StartedTestContainer> {
    return await new GenericContainer(TestEnvironment.DATABASE_VERSION)
      .withExposedPorts(6875)
      .withEnvironment({
        MZ_WORKERS: TestEnvironment.DATABASE_WORKERS
      })
      .withStartupTimeout(120000)
      .start();
  }

  /**
   * Create a database client using environment variables
   */
  private async createDatabaseClient(): Promise<Client> {
    const client = new Client({
      host: process.env.DATABASE_HOST,
      port: parseInt(process.env.DATABASE_PORT!),
      user: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: process.env.DATABASE_NAME
    });
    
    await client.connect();
    return client;
  }

  /**
   * Set up environment variables for the test
   */
  private setupEnvironmentVariables(): void {
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = this.databasePort.toString();
    process.env.DATABASE_USER = 'materialize';
    process.env.DATABASE_PASSWORD = 'materialize';
    process.env.DATABASE_NAME = 'materialize';
    process.env.GRAPHQL_PORT = this.appPort.toString();
    process.env.GRAPHQL_UI = 'false';
    process.env.SCHEMA_PATH = this.schemaPath;
    process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
  }

  /**
   * Create and configure the NestJS application for testing
   */
  private async createTestApp(): Promise<INestApplication> {
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
}