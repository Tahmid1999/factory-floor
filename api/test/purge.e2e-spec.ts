import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { FixedClock } from '../src/clock';
import type { HoodEvent } from '../src/hood/hood-event';
import { PurgeService } from '../src/purge/purge.service';
import { Rabbit } from '../src/rabbit';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

const DAY = 24 * 60 * 60 * 1000;

describe('guest purge', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  const hood: HoodEvent[] = [];
  const clock = new FixedClock(new Date('2026-10-15T10:00:00Z'));

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    prisma = new PrismaClient();
    await api.get(Rabbit).consumeHood((e) => hood.push(e));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  const totals = async () => {
    const rows = await prisma.posting.groupBy({ by: ['period'], _sum: { amountMills: true }, _count: true });
    return Object.fromEntries(rows.map((r) => [r.period, [r._sum.amountMills, r._count]]));
  };
  const postedFor = async (code: string) =>
    (await prisma.posting.findFirst({ where: { bundleCode: code, amountMills: 300 } })) ?? false;

  it('orphans the postings of a guest older than 24 h and leaves every period total as it was', async () => {
    // October work by a guest who is then more than a day old.
    const old = await makeGuest(api, clock, ['S-07']);
    await old.batch('S-07', [old.ev(1, old.codes[0], 'sew_collar', 3000)]).expect(201);
    await until(() => postedFor(old.codes[0]));

    clock.set(new Date('2026-10-16T12:00:00Z'));
    const fresh = await makeGuest(api, clock, ['S-07']);
    await fresh.batch('S-07', [fresh.ev(1, fresh.codes[0], 'sew_collar', 3000)]).expect(201);
    await until(() => postedFor(fresh.codes[0]));

    const before = await totals();
    expect(before['2026-10']).toBeDefined();
    const oldGuest = await prisma.guest.findUniqueOrThrow({ where: { name: old.name } });
    const oldDevice = old.devices['S-07'];

    expect(await worker.get(PurgeService).runOnce()).toBe(1);

    expect(await totals()).toEqual(before);
    expect(await prisma.guest.findUnique({ where: { name: old.name } })).toBeNull();
    expect(await prisma.guest.findUnique({ where: { name: fresh.name } })).not.toBeNull();
    expect(await prisma.device.count({ where: { id: oldDevice } })).toBe(0);
    expect(await prisma.scanInbox.count({ where: { deviceId: oldDevice } })).toBe(0);
    expect(await prisma.bundle.count({ where: { guestId: oldGuest.id } })).toBe(0);
    expect(await prisma.bundle.count({ where: { code: { in: old.codes } } })).toBe(0);
    expect(await prisma.bundle.count({ where: { code: { in: fresh.codes } } })).toBe(3);

    const orphaned = await prisma.posting.findMany({ where: { bundleCode: { in: old.codes } } });
    expect(orphaned.length).toBeGreaterThan(0);
    for (const p of orphaned) {
      expect(p.guestId).toBeNull();
      expect(p.guestPurged).toBe(true);
    }
    for (const p of await prisma.posting.findMany({ where: { bundleCode: { in: fresh.codes } } })) {
      expect(p.guestPurged).toBe(false);
    }

    await until(async () => hood.find((e) => e.kind === 'purge'));
    expect(hood.find((e) => e.kind === 'purge')).toMatchObject({ proc: 'worker', text: 'purge 1 guests' });
  });

  it('publishes nothing when there is nobody to purge', async () => {
    const n = hood.filter((e) => e.kind === 'purge').length;
    expect(await worker.get(PurgeService).runOnce()).toBe(0);
    await new Promise((r) => setTimeout(r, 300));
    expect(hood.filter((e) => e.kind === 'purge')).toHaveLength(n);
  });

  it('deletes sim inbox rows and events older than 60 days but keeps their postings', async () => {
    const now = clock.now();
    const simDevice = await prisma.device.create({
      data: { code: 'S-07', isSimulated: true, registeredAt: new Date(now.getTime() - 90 * DAY), simName: 'purge-test' },
    });
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const bundle = await prisma.bundle.create({
      data: { code: 'B-9001', styleId: style.id, pieces: 20, status: 'active', nextStep: 2, isSimulated: true },
    });
    const make = async (seq: number, ageDays: number) => {
      const at = new Date(now.getTime() - ageDays * DAY);
      const inbox = await prisma.scanInbox.create({
        data: {
          deviceId: simDevice.id,
          seq,
          bundleCode: bundle.code,
          op: 'sew_collar',
          scannedAt: at,
          offsetMs: 0,
          correctedAt: at,
          receivedAt: at,
          result: 'applied',
        },
      });
      const event = await prisma.bundleEvent.create({
        data: {
          bundleId: bundle.id,
          op: 'sew_collar',
          source: 'batch',
          deviceId: simDevice.id,
          inboxId: inbox.id,
          round: 0,
          correctedAt: at,
          isSimulated: true,
        },
      });
      await prisma.posting.create({
        data: {
          period: at.toISOString().slice(0, 7),
          kind: 'labour',
          amountMills: 300,
          bundleCode: bundle.code,
          eventId: event.id,
          isSimulated: true,
        },
      });
      return { inbox, event };
    };
    const stale = await make(1, 70);
    const recent = await make(2, 10);
    const postings = await prisma.posting.count({ where: { bundleCode: bundle.code } });

    await worker.get(PurgeService).runOnce();

    expect(await prisma.scanInbox.findUnique({ where: { id: stale.inbox.id } })).toBeNull();
    expect(await prisma.bundleEvent.findUnique({ where: { id: stale.event.id } })).toBeNull();
    expect(await prisma.scanInbox.findUnique({ where: { id: recent.inbox.id } })).not.toBeNull();
    expect(await prisma.bundleEvent.findUnique({ where: { id: recent.event.id } })).not.toBeNull();
    expect(await prisma.posting.count({ where: { bundleCode: bundle.code } })).toBe(postings);
  });
});
