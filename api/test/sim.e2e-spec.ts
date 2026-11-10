import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'node:net';
import { FixedClock } from '../src/clock';
import { POLO_ROUTE } from '../src/line/line';
import { SimService, simConfigFromEnv } from '../src/sim/sim.service';
import request from 'supertest';
import { bootApi, bootWorker, emptyStock, expectBundlesFollowRules, purgeQueues, resetDb, until } from './helpers';

// A small seeded generator, so a failing run can be run again.
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('simulated line', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  let sim: SimService;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    await api.listen(0);
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    prisma = new PrismaClient();
    const port = (api.getHttpServer().address() as AddressInfo).port;
    // Rates are higher and windows shorter than on the real line, so 200
    // ticks of a fixed clock reach every path; the code under test is the same.
    sim = new SimService(
      {
        ...simConfigFromEnv({ ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${port}` }),
        random: mulberry32(1),
        offlineChance: 0.12,
        offlineMs: [4_000, 12_000],
        flagChance: 0.3,
        failChance: 0.15,
      },
      clock,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  // The worker applies a batch after the api has replied, so a step that
  // depends on the last one waits for the inbox to empty.
  const drained = () => until(async () => (await prisma.scanInbox.count({ where: { result: null } })) === 0);

  it('runs 200 ticks through the public api and leaves every bundle in a state the rules allow', async () => {
    // Devices are registered by the first tick; scans must come after that.
    await sim.tick();
    for (let i = 0; i < 200; i++) {
      clock.advance(3000);
      await sim.tick();
      await drained();
    }
    for (const dev of sim.batch.values()) await dev.setOnline(true);
    await drained();

    const released = await prisma.scanInbox.count({ where: { heldAt: { not: null }, result: 'applied' } });
    const cleared = await prisma.bundleEvent.count({ where: { op: 'clear_rework', isSimulated: true } });
    expect(released).toBeGreaterThanOrEqual(1);
    expect(sim.resyncsHandled).toBeGreaterThanOrEqual(1);
    expect(sim.stats.clears).toBeGreaterThanOrEqual(1);
    expect(cleared).toBe(sim.stats.clears);

    const bundles = await expectBundlesFollowRules(prisma);
    expect(bundles.length).toBeGreaterThan(10);
    expect(POLO_ROUTE).toEqual(bundles[0].style.route);
  });
});

// Inline QC may look at a bundle that is already waiting for final QC. On the
// live line that look used to count as the final check too, and the bundle
// sat at qc_final for good.
describe('final QC after inline QC', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  let sim: SimService;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const qcFinal = POLO_ROUTE.indexOf('qc_final');

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    await api.listen(0);
    prisma = new PrismaClient();
    const port = (api.getHttpServer().address() as AddressInfo).port;
    sim = new SimService(
      { ...simConfigFromEnv({ ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${port}` }), flagChance: 0, failChance: 0 },
      clock,
    );
    const style = await prisma.style.findFirstOrThrow();
    for (const code of ['B-9001', 'B-9002']) {
      await prisma.bundle.create({
        data: { code, styleId: style.id, pieces: 20, status: 'active', nextStep: qcFinal, isSimulated: true },
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await api.close();
  });

  it('still passes a bundle inline QC has looked at', async () => {
    await sim.tick();
    // Inline QC looks at both, then final QC works through what it has.
    while (await sim['inspectInline']()) {}
    while (await sim['finalCheck']()) {}
    const after = await prisma.bundle.findMany({
      where: { code: { in: ['B-9001', 'B-9002'] } },
      select: { code: true, nextStep: true },
      orderBy: { code: 'asc' },
    });
    expect(after).toEqual([
      { code: 'B-9001', nextStep: qcFinal + 1 },
      { code: 'B-9002', nextStep: qcFinal + 1 },
    ]);
  });
});

// The storekeeper is the one sim move that is not a station: it reads the
// stock and receives a lot of 6 when fewer than 3 rolls can still cut a bundle.
describe('sim storekeeper', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  let sim: SimService;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));

  beforeAll(async () => {
    await resetDb();
    api = await bootApi(clock);
    await api.listen(0);
    prisma = new PrismaClient();
    const port = (api.getHttpServer().address() as AddressInfo).port;
    sim = new SimService(
      { ...simConfigFromEnv({ ...process.env, API_INTERNAL_URL: `http://127.0.0.1:${port}` }), random: mulberry32(7) },
      clock,
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await api.close();
  });

  it('answers /sim/stock and /stock/receive to the sim only', async () => {
    await request(api.getHttpServer()).get('/sim/stock').expect(404);
    const res = await request(api.getHttpServer()).get('/sim/stock').set('x-sim-key', process.env.SIM_KEY!).expect(200);
    expect(res.body).toEqual({ cuttableRolls: await prisma.roll.count({ where: { isTest: false } }) });
  });

  it('does nothing while 3 or more rolls can cut, and receives 6 at a drawn price below that', async () => {
    const rolls0 = await prisma.roll.count();
    expect(await sim['store']()).toBe(false);
    expect(await prisma.roll.count()).toBe(rolls0);

    await emptyStock();
    expect(await sim['store']()).toBe(true);
    const rolls = await prisma.roll.findMany({ include: { movements: true } });
    expect(rolls).toHaveLength(6);
    const cost = rolls[0].costPerMetreMills;
    expect(cost).toBeGreaterThanOrEqual(3200);
    expect(cost).toBeLessThanOrEqual(3600);
    expect(cost % 50).toBe(0);
    for (const r of rolls) {
      expect(r).toMatchObject({ lengthCm: 30_000, costPerMetreMills: cost, isTest: false, isSimulated: true });
      expect(r.movements).toEqual([
        expect.objectContaining({ kind: 'receive', deltaCm: 30_000, actor: 'sim-store', isSimulated: true }),
      ]);
    }
    // No device: receiving fabric is not a scan.
    expect(await prisma.device.count({ where: { simName: 'sim-store' } })).toBe(0);
    expect(await sim['store']()).toBe(false);
  });
});
