import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import * as http from 'node:http';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { HoodService } from '../src/hood/hood';
import type { HoodEvent } from '../src/hood/hood-event';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

const BATCH_LINE = /^batch dev-S\d\d seq \d+-\d+ · \d+ in · \d+ rejected( \(\w+\))? · \d+ ms$/;

// Reads the stream as a client would: raw chunks off a live socket.
function openStream(port: number) {
  const chunks: string[] = [];
  const req = http.get({ port, path: '/events/stream', host: '127.0.0.1' }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c: string) => chunks.push(c));
  });
  const text = () => chunks.join('');
  const lines = () =>
    text()
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)) as HoodEvent);
  return { text, lines, close: () => req.destroy() };
}

describe('under the hood', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  let port: number;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const recent = async () => (await request(api.getHttpServer()).get('/events/recent').expect(200)).body as HoodEvent[];

  beforeAll(async () => {
    process.env.HOOD_HEARTBEAT_MS = '100';
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    await api.listen(0, '127.0.0.1');
    port = (api.getHttpServer().address() as { port: number }).port;
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    delete process.env.HOOD_HEARTBEAT_MS;
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  it('streams a batch line with the exact shape, rework rejections included', async () => {
    const g = await makeGuest(api, clock, ['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.batch('S-07', [g.ev(1, code, 'sew_collar', 5000)]).expect(201);
    await until(async () => (await prisma.scanInbox.findFirst({ where: { bundleCode: code, result: 'applied' } })) ?? false);
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'collar' }).expect(200);
    clock.advance(1000);

    const stream = openStream(port);
    await g.batch('S-08', [g.ev(2, code, 'sew_sleeve'), g.ev(3, code, 'sew_sleeve'), g.ev(4, code, 'sew_sleeve')]).expect(201);
    const line = await until(async () => stream.lines().find((e) => e.kind === 'batch' && /seq 2-4/.test(e.text)));
    stream.close();
    expect(line.proc).toBe('api');
    expect(line.text).toMatch(BATCH_LINE);
    expect(line.text).toMatch(/^batch dev-S08 seq 2-4 · 3 in · 3 rejected \(rework\) · \d+ ms$/);
    // Three scans of one bundle turned back: one resync line, no ids or names.
    await until(async () => (await recent()).some((e) => e.kind === 'resync'));
    expect((await recent()).filter((e) => e.kind === 'resync').map((e) => e.text)).toEqual([
      `resync ${code} → rework · dev-S08`,
    ]);
  });

  it('replays the buffer first, then goes live, and keeps the connection warm', async () => {
    const stream = openStream(port);
    await until(async () => stream.lines().length > 0);
    const before = stream.lines().length;
    api.get(HoodService).emit('sweep', 'sweep republished 7');
    await until(async () => stream.lines().length === before + 1);
    expect(stream.lines().at(-1)!.text).toBe('sweep republished 7');
    await until(async () => stream.text().includes(': hb'));
    stream.close();
  });

  it('shows worker lines, each once, though the api hears its own back from the fanout', async () => {
    const g = await makeGuest(api, clock, ['S-07']);
    const code = g.codes[1];
    await g.batch('S-07', [g.ev(1, code, 'sew_collar', 3000)]).expect(201);
    const worked = await until(async () => (await recent()).find((e) => e.text.startsWith(`apply ${code} sew_collar`)));
    expect(worked.proc).toBe('worker');
    expect(worked.text).toMatch(/^apply B-\d+ sew_collar · lock \d+ ms · tx \d+ ms$/);

    api.get(HoodService).emit('sweep', 'sweep republished 1234');
    await new Promise((r) => setTimeout(r, 500));
    expect((await recent()).filter((e) => e.text === 'sweep republished 1234')).toHaveLength(1);
  });

  it('publishes nothing for an empty heartbeat batch', async () => {
    const g = await makeGuest(api, clock, ['S-07']);
    const before = (await recent()).length;
    await g.batch('S-07', []).expect(201);
    await new Promise((r) => setTimeout(r, 300));
    expect(await recent()).toHaveLength(before);
  });

  it('says limit for a 429, once, and never names the guest or the ip', async () => {
    const g = await makeGuest(api, clock, ['S-09']);
    await g.batch('S-09', []).expect(201);
    await g.batch('S-09', []).expect(201);
    await g.batch('S-09', []).expect(429);
    await g.batch('S-09', []).expect(429);
    await until(async () => (await recent()).some((e) => e.text === 'limit dev-S09 batch'));
    expect((await recent()).filter((e) => e.text === 'limit dev-S09 batch')).toHaveLength(1);
  });

  it('keeps no guest name, cookie, ip or raw device id in the last 200 lines', async () => {
    const lines = await recent();
    expect(lines.length).toBeGreaterThan(3);
    const guests = await prisma.guest.findMany({ select: { name: true } });
    const devices = await prisma.device.findMany({ select: { id: true } });
    const all = JSON.stringify(lines);
    for (const g of guests) expect(all).not.toContain(g.name);
    for (const d of devices) expect(all).not.toContain(d.id);
    expect(all).not.toContain('ff_guest');
    expect(all).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(all).not.toContain('"pid"');
  });

  it('keeps only the last 200', async () => {
    const hood = api.get(HoodService);
    for (let i = 0; i < 250; i++) hood.emit('sweep', `sweep republished ${i}`);
    const lines = await recent();
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)!.text).toBe('sweep republished 249');
  });
});
