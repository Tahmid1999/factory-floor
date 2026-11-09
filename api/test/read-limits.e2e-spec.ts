import { INestApplication } from '@nestjs/common';
import * as http from 'node:http';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { bootApi, purgeQueues, resetDb, until } from './helpers';

function openStream(port: number) {
  let status = 0;
  const req = http.get({ port, path: '/events/stream', host: '127.0.0.1' }, (res) => {
    status = res.statusCode ?? 0;
    res.resume();
  });
  req.on('error', () => undefined);
  return { status: () => status, close: () => req.destroy() };
}

describe('limits on open reads', () => {
  let api: INestApplication;
  let port: number;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));

  beforeAll(async () => {
    process.env.HOOD_MAX_STREAMS = '2';
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    await api.listen(0, '127.0.0.1');
    port = (api.getHttpServer().address() as { port: number }).port;
  });

  afterAll(async () => {
    delete process.env.HOOD_MAX_STREAMS;
    await api.close();
  });

  it('gives one address 120 reads of /me a minute, then 429 until the minute is over', async () => {
    const agent = request.agent(api.getHttpServer());
    const ip = '203.0.113.200';
    for (let i = 0; i < 120; i++) await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    await agent.get('/me').set('x-forwarded-for', ip).expect(429);
    // Another address has its own count.
    await request(api.getHttpServer()).get('/me').set('x-forwarded-for', '203.0.113.201').expect(200);
    clock.advance(60_000);
    await agent.get('/me').set('x-forwarded-for', ip).expect(200);
  });

  it('counts the admin reads apart from /me', async () => {
    const ip = '203.0.113.202';
    const read = () => request(api.getHttpServer()).get('/admin/floor').set('x-forwarded-for', ip);
    for (let i = 0; i < 120; i++) await read().expect(200);
    await read().expect(429);
    await request(api.getHttpServer()).get('/me').set('x-forwarded-for', ip).expect(200);
  });

  it('keeps open streams under the cap, and frees a slot when one closes', async () => {
    const a = openStream(port);
    const b = openStream(port);
    await until(async () => a.status() === 200 && b.status() === 200);
    const c = openStream(port);
    await until(async () => c.status() === 503);
    a.close();
    await new Promise((r) => setTimeout(r, 200));
    const d = openStream(port);
    await until(async () => d.status() === 200);
    for (const s of [b, c, d]) s.close();
  });
});
