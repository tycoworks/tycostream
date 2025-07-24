import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DatabaseConnectionService } from '../src/database/database-connection.service';

describe('Minimal E2E Test', () => {
  let app: INestApplication;

  beforeAll(async () => {
    // Set minimal environment variables
    process.env.DATABASE_HOST = 'localhost';
    process.env.DATABASE_PORT = '6875';
    process.env.DATABASE_USER = 'materialize';
    process.env.DATABASE_PASSWORD = 'materialize';
    process.env.DATABASE_NAME = 'materialize';
    process.env.GRAPHQL_PORT = '4003';
    process.env.GRAPHQL_UI = 'false';
    process.env.SCHEMA_PATH = 'test/graphql-subscriptions-schema.yaml';
    process.env.LOG_LEVEL = 'error';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
    .overrideProvider(DatabaseConnectionService)
    .useValue({
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      onNotification: jest.fn(),
    })
    .compile();

    app = moduleFixture.createNestApplication();
    await app.listen(4003);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('should start successfully', () => {
    expect(app).toBeDefined();
  });
});