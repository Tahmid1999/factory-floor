import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as amqp from 'amqplib';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { CLOCK, Clock, FixedClock } from '../src/clock';
import { APPLY_QUEUE } from '../src/rabbit';
import { seedLine } from '../src/seed';
import { WorkerModule } from '../src/worker.module';

export async function bootApi(clock: Clock = new FixedClock()): Promise<INestApplication> {
  const mod = await Test.createTestingModule({ imports: [AppModule] })
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
