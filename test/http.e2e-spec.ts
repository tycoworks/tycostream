import * as path from 'path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../src/app.module.js';
import databaseConfig from '../src/config/database.config.js';
import graphqlConfig from '../src/config/graphql.config.js';
import sourcesConfig from '../src/config/sources.config.js';

/**
 * HTTP behaviour of the GraphQL endpoint that browser clients rely on,
 * and that the Node test clients in the other suites can't see.
 * No database is needed: tycostream only connects when a client subscribes,
 * and nothing listens on the database port, so a subscription's connection
 * fails.
 */
async function createApp(graphqlUI: boolean): Promise<INestApplication<App>> {
  process.env.DATABASE_HOST = 'localhost';
  process.env.DATABASE_PORT = '1';
  process.env.DATABASE_USER = 'materialize';
  process.env.DATABASE_PASSWORD = 'materialize';
  process.env.DATABASE_NAME = 'materialize';
  process.env.GRAPHQL_PORT = '4200';
  process.env.GRAPHQL_UI = graphqlUI.toString();
  process.env.SCHEMA_PATH = path.join(
    import.meta.dirname,
    'integration-schema.yaml',
  );

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideModule(ConfigModule)
    .useModule(
      ConfigModule.forRoot({
        isGlobal: true,
        cache: false,
        load: [databaseConfig, graphqlConfig, sourcesConfig],
      }),
    )
    .compile();

  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useLogger(['error']);
  await app.init();
  return app;
}

describe('HTTP', () => {
  describe('with the GraphQL UI on', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await createApp(true);
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows a CORS preflight from another origin, as browser clients need', async () => {
      const response = await request(app.getHttpServer())
        .options('/graphql')
        .set('Origin', 'http://localhost:5173')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(response.status).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(
        'http://localhost:5173',
      );
    });

    it('serves GraphiQL to a browser', async () => {
      const response = await request(app.getHttpServer())
        .get('/graphql')
        .set('Accept', 'text/html');

      expect(response.status).toBe(200);
      expect(response.text).toContain('GraphiQL');
    });
  });

  describe('with the GraphQL UI off', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      app = await createApp(false);
    });

    afterAll(async () => {
      await app.close();
    });

    it('ends a subscription whose database connection fails with a GraphQL error, and keeps serving', async () => {
      const subscription = await request(app.getHttpServer())
        .post('/graphql')
        .set('Accept', 'text/event-stream')
        .send({ query: 'subscription { users { operation } }' });

      expect(subscription.text).toContain('"errors"');
      expect(subscription.text).toContain('event: complete');

      const ping = await request(app.getHttpServer())
        .post('/graphql')
        .send({ query: '{ ping }' });
      expect(ping.body).toEqual({ data: { ping: 'pong' } });
    });

    it('refuses to serve GraphiQL', async () => {
      const response = await request(app.getHttpServer())
        .get('/graphql')
        .set('Accept', 'text/html');

      expect(response.status).toBe(406);
      expect(response.text).not.toContain('GraphiQL');
    });
  });
});
