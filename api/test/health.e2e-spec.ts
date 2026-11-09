import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApi } from './helpers';

describe('health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootApi();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports postgres and rabbit as ok', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toEqual({ postgres: 'ok', rabbit: 'ok' });
  });
});
