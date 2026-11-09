import { INestApplication, INestApplicationContext, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CLOCK, Clock, FixedClock } from '../src/clock';
import { APPLY_QUEUE } from '../src/rabbit';
import { seedLine } from '../src/seed';
import { WorkerModule } from '../src/worker.module';

type BootOptions = { clock?: Clock; extraControllers?: Type<unknown>[] };

// Takes a bare clock as before, or options when a spec needs routes of its own.
export async function bootApi(arg: Clock | BootOptions = new FixedClock()): Promise<INestApplication> {
  const opts: BootOptions = 'now' in arg ? { clock: arg } : arg;
  const clock = opts.clock ?? new FixedClock();
  const mod = await Test.createTestingModule({ imports: [AppModule], controllers: opts.extraControllers ?? [] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  const app = mod.createNestApplication();
  await app.init();
  return app;
}

export async function bootWorker(clock: Clock = new FixedClock()): Promise<INestApplicationContext> {
  const mod = await Test.createTestingModule({ imports: [WorkerModule] })
    .overrideProvider(CLOCK)
    .useValue(clock)
    .compile();
  return mod.init();
}

export async function resetDb(): Promise<void> {
  // TRUNCATE needs rights ff_app deliberately lacks on AuditLog, so the
  // wipe goes through the owner role and seeding through the app role.
  const owner = new PrismaClient({ datasources: { db: { url: process.env.TEST_OWNER_DATABASE_URL } } });
  const app = new PrismaClient();
  try {
    const tables = await owner.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
    const list = tables.map((t) => `"${t.tablename}"`).join(', ');
    await owner.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    await owner.$executeRawUnsafe('ALTER SEQUENCE bundle_code_seq RESTART WITH 8492');
    await seedLine(app);
  } finally {
    await owner.$disconnect();
    await app.$disconnect();
  }
}

export async function purgeQueues(): Promise<void> {
  const conn = await amqp.connect(process.env.RABBIT_URL!);
  try {
    const ch = await conn.createChannel();
    await ch.assertQueue(APPLY_QUEUE, { durable: true });
    await ch.purgeQueue(APPLY_QUEUE);
  } finally {
    await conn.close();
  }
}

let nextIp = 100;

// A visitor with one device per station asked for, and the visitor's 3
// bundles. The clock moves a minute on so the devices exist before any scan.
export async function makeGuest(api: INestApplication, clock: FixedClock, stations: string[]) {
  const agent = request.agent(api.getHttpServer());
  const ip = `198.51.100.${nextIp++}`;
  const me = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
  const devices: Record<string, string> = {};
  for (const station of stations) {
    const dev = await agent.post('/devices').set('x-forwarded-for', ip).send({ station }).expect(201);
    devices[station] = dev.body.deviceId;
  }
  clock.advance(60_000);
  const codes: string[] = me.body.bundles.map((b: { code: string }) => b.code);
  const ev = (seq: number, bundleCode: string, op: string, agoMs = 0) => ({
    seq,
    bundleCode,
    op,
    scannedAt: clock.now().getTime() - agoMs,
    offsetMs: 0,
  });
  const batch = (station: string, events: object[]) =>
    agent
      .post('/scans/batch')
      .set('x-forwarded-for', ip)
      .send({ deviceId: devices[station], deviceNow: clock.now().getTime(), events });
  const gate = (station: string, body: object) =>
    agent
      .post('/gate/scan')
      .set('x-forwarded-for', ip)
      .send({ deviceId: devices[station], gateId: randomUUID(), ...body });
  return { name: me.body.name as string, ip, devices, codes, ev, batch, gate };
}

export async function until<T>(check: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}
