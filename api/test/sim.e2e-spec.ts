import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { AddressInfo } from 'node:net';
import { FixedClock } from '../src/clock';
import { POLO_ROUTE } from '../src/line/line';
import { decide } from '../src/line/state-machine';
import { SimService, simConfigFromEnv } from '../src/sim/sim.service';
import { bootApi, bootWorker, purgeQueues, resetDb, until } from './helpers';

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
        random: mulberry32(7),
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

    const bundles = await prisma.bundle.findMany({ where: { isSimulated: true }, include: { style: true } });
    expect(bundles.length).toBeGreaterThan(10);
    for (const b of bundles) {
      const events = await prisma.bundleEvent.findMany({ where: { bundleId: b.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
      expect(events.every((e) => e.isSimulated)).toBe(true);
      const state = { status: 'active' as string, nextStep: 0, route: b.style.route, reworkRound: 0 };
      const done: { op: string; round: number }[] = [];
      for (const e of events) {
        if (e.op === 'qc_flag' || e.op === 'qc_fail') {
          state.status = 'rework';
        } else if (e.op === 'clear_rework') {
          // The event does not store where it went; the gate reply does.
          state.status = 'active';
          state.nextStep = b.style.route.indexOf((e.gateReply as { nextOp: string }).nextOp);
          state.reworkRound += 1;
        } else if (e.op === 'scrap') {
          state.status = 'scrapped';
        } else {
          const d = decide(state as never, e.op, done);
          expect({ bundle: b.code, op: e.op, round: e.round, decision: d.kind }).toEqual({
            bundle: b.code,
            op: e.op,
            round: state.reworkRound,
            decision: 'apply',
          });
          done.push({ op: e.op, round: state.reworkRound });
          state.nextStep += 1;
          if (e.op === 'pack') state.status = 'packed';
          if (e.op === 'ship') state.status = 'shipped';
        }
      }
      expect({ code: b.code, status: state.status, nextStep: state.nextStep, round: state.reworkRound }).toEqual({
        code: b.code,
        status: b.status,
        nextStep: b.nextStep,
        round: b.reworkRound,
      });
    }
    expect(POLO_ROUTE).toEqual(bundles[0].style.route);
  });
});
