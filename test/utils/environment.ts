import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ConfigModule, registerAs } from '@nestjs/config';
import { GenericContainer, StartedTestContainer } from 'testcontainers';
import { Client } from 'pg';
import { AppModule } from '../../src/app.module';
import databaseConfig from '../../src/config/database.config';
import graphqlConfig from '../../src/config/graphql.config';
import { TestClientManager } from './manager';
import { TestClient } from './client';
import { Stats } from './events';
import sourcesConfig from '../../src/config/sources.config';
import { WebhookServer } from './webhook';

/**
 * Database configuration for TestEnvironment
 */
export interface DatabaseConfig {
  host: string;      // Database host
  port: number;      // Database port
  user: string;      // Database user
  password: string;  // Database password
  name: string;      // Database name
  workers: string;   // Number of Materialize workers
}

/**
 * Webhook server configuration
 */
export interface WebhookConfig {
  port: number;
}

/**
 * GraphQL endpoint configuration
 */
export interface GraphQLEndpoint {
  host: string;  // e.g., "localhost"
  port: number;  // e.g., 4001
  path: string;  // e.g., "/graphql"
}


/**
 * Complete test environment configuration
 */
export interface TestEnvironmentConfig {
  appPort: number;
  schemaPath: string;
  database: DatabaseConfig;
  graphqlUI: boolean;        // Enable GraphQL UI
  logLevel: 'verbose' | 'debug' | 'log' | 'warn' | 'error' | 'fatal';  // Log level
  webhook: WebhookConfig;  // Webhook server configuration (always required)
}

/**
 * Test environment that manages all infrastructure needed for E2E tests
 * Handles database container, connections, and NestJS app lifecycle
 */
export class TestEnvironment {
  private app: INestApplication;
  private databaseContainer: StartedTestContainer;
  private databaseClient: Client;
  private databasePort: number;  // Mapped port from Docker container
  private webhookServer: WebhookServer;
  private config: TestEnvironmentConfig;
  private clientManager: TestClientManager;

  private static readonly DATABASE_VERSION = 'materialize/materialized:v0.124.0';

  constructor(config: TestEnvironmentConfig) {
    this.config = config;
  }

  /**
   * Bootstrap the complete test environment
   */
  async setup(): Promise<void> {
    // Start database container
    console.log('Starting database container...');
    this.databaseContainer = await this.createDatabaseContainer();
    this.databasePort = this.databaseContainer.getMappedPort(this.config.database.port);
    console.log(`Database container started on port ${this.databasePort}`);
    
    // Create database client
    console.log('Creating database client...');
    this.databaseClient = await this.createDatabaseClient();
    console.log('Database client connected');
    
    // Create and start app
    console.log('Creating NestJS application...');
    this.app = await this.createTestApp();
    await this.app.listen(this.config.appPort);
    console.log(`Application listening on port ${this.config.appPort}`);
    
    // Create and start webhook server
    console.log('Starting webhook server...');
    this.webhookServer = this.createWebhookServer();
    console.log(`Webhook server listening on port ${this.config.webhook.port}`);
    
    // Create client manager with all dependencies configured
    console.log('Creating client manager...');
    this.clientManager = this.createClientManager();
    console.log('Client manager created');
    
    // Wait for server to stabilize
    await new Promise(resolve => setTimeout(resolve, 1000));
    console.log('Test environment ready');
  }

  
  /**
   * Create a client and return it for direct use
   */
  createClient<TData = any>(id: string): TestClient<TData> {
    return this.clientManager.createClient(id);
  }
  
  /**
   * Wait for all clients to complete
   */
  async waitForCompletion(): Promise<void> {
    return this.clientManager.waitForCompletion();
  }
  
  /**
   * Get aggregated statistics for all clients
   */
  getStats(): Stats {
    return this.clientManager.getStats();
  }
  
  /**
   * Stop and clean up all test resources
   */
  async stop(): Promise<void> {
    console.log('Starting test environment shutdown...');
    
    // Dispose all clients
    console.log('Disposing all test clients...');
    await this.clientManager.dispose();
    console.log('Test clients disposed');
    
    // Close webhook server
    console.log('Stopping webhook server...');
    this.webhookServer.stop();
    console.log('Webhook server stopped');
    // Close app first
    console.log('Closing NestJS application...');
    await this.app.close();
    console.log('NestJS application closed');
    
    // Wait for connections to close
    console.log('Waiting for connections to close...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Close database connection
    console.log('Closing database connection...');
    await this.databaseClient.end();
    console.log('Database connection closed');
    
    // Stop container last
    console.log('Stopping database container...');
    await this.databaseContainer.stop();
    console.log('Database container stopped');
    
    console.log('Test environment shutdown complete');
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
    return this.config.appPort;
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
  static async create(config: TestEnvironmentConfig): Promise<TestEnvironment> {
    const env = new TestEnvironment(config);
    await env.setup();
    return env;
  }

  /**
   * Create and start a database container
   */
  private async createDatabaseContainer(): Promise<StartedTestContainer> {
    return await new GenericContainer(TestEnvironment.DATABASE_VERSION)
      .withExposedPorts(this.config.database.port)
      .withEnvironment({
        MZ_WORKERS: this.config.database.workers
      })
      .withStartupTimeout(120000)
      .start();
  }

  /**
   * Create a database client using config
   */
  private async createDatabaseClient(): Promise<Client> {
    const client = new Client({
      host: this.config.database.host,
      port: this.databasePort,  // Use mapped port from container
      user: this.config.database.user,
      password: this.config.database.password,
      database: this.config.database.name
    });
    
    await client.connect();
    return client;
  }

  /**
   * Create and start a webhook server
   */
  private createWebhookServer(): WebhookServer {
    const server = new WebhookServer(this.config.webhook.port);
    server.start();
    return server;
  }

  /**
   * Set up environment variables for the test
   */
  private setupEnvironmentVariables(): void {
    process.env.DATABASE_HOST = this.config.database.host;
    process.env.DATABASE_PORT = this.databasePort.toString();
    process.env.DATABASE_USER = this.config.database.user;
    process.env.DATABASE_PASSWORD = this.config.database.password;
    process.env.DATABASE_NAME = this.config.database.name;
    process.env.GRAPHQL_PORT = this.config.appPort.toString();
    process.env.GRAPHQL_UI = this.config.graphqlUI.toString();
    process.env.SCHEMA_PATH = this.config.schemaPath;
    process.env.LOG_LEVEL = this.config.logLevel;
  }


  /**
   * Create and configure the NestJS application for testing
   */
  private async createTestApp(): Promise<INestApplication> {
    this.setupEnvironmentVariables();
    
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideModule(ConfigModule)
    .useModule(
      ConfigModule.forRoot({
        isGlobal: true,
        cache: false,
        load: [databaseConfig, graphqlConfig, sourcesConfig],
      })
    )
    .compile();

    const app = moduleFixture.createNestApplication();
    
    // Set log level
    app.useLogger([this.config.logLevel]);
    
    return app;
  }

  /**
   * Create a configured TestClientManager
   */
  private createClientManager(): TestClientManager {
    const graphqlEndpoint = {
      host: 'localhost',
      port: this.config.appPort,
      path: '/graphql'
    };
    
    return new TestClientManager(graphqlEndpoint, this.webhookServer, 30000);
  }
}