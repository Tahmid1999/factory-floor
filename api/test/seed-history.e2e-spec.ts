import { PrismaClient } from '@prisma/client';
import { pnlLines } from '../src/money/pnl';
import { runHistory } from '../src/seed-history';
import { expectBundlesFollowRules, purgeQueues, resetDb } from './helpers';

// Four hours across the end of October at the seed's own settings: 5 min
// ticks of 5 moves, and the live pace from 23:00 to 01:00, so the close at
// 00:05 and S-09's scripted outage both fall inside the run.
const run = () =>
  runHistory({
    from: new Date('2026-10-31T22:00:00Z'),
    until: () => new Date('2026-11-01T02:00:00Z'),
    tickMs: 300_000,
    movesPerTick: 5,
    log: () => undefined,
  });

describe('seeded month', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    delete process.env.SEED_MODE;
    await prisma.$disconnect();
  });

  it('refuses to run without SEED_MODE=1', async () => {
    delete process.env.SEED_MODE;
    await expect(run()).rejects.toThrow('SEED_MODE=1');
    expect(await prisma.bundle.count()).toBe(0);
  });

  it('runs the sim across the month end, closes October once at 00:05 and books S-09 late', async () => {
    process.env.SEED_MODE = '1';
    const summary = await run();

    const closes = await prisma.periodClose.findMany();
    expect(closes.map((c) => ({ period: c.period, by: c.closedBy, at: c.closedAt.toISOString() }))).toEqual([
      { period: '2026-10', by: 'seed', at: '2026-11-01T00:05:00.000Z' },
    ]);

    // S-09 was off the network from 23:50, so what it sewed in October reached
    // the api after the close and went to November as an adjustment.
    const s09 = await prisma.device.findFirstOrThrow({ where: { isSimulated: true, code: 'S-09' } });
    const late = await prisma.$queryRaw<{ kind: string; correctedAt: Date }[]>`
      SELECT p."kind"::text AS kind, e."correctedAt"
      FROM "Posting" p JOIN "BundleEvent" e ON e."id" = p."eventId"
      WHERE p."period" = '2026-11' AND p."adjustsPeriod" = '2026-10' AND e."deviceId" = ${s09.id}`;
    // At the live pace S-09 sews about once a minute while it has work.
    expect(late.length).toBeGreaterThanOrEqual(3);
    expect(summary.late).toBe(await prisma.posting.count({ where: { adjustsPeriod: '2026-10' } }));
    for (const p of late) expect(p.correctedAt.getTime()).toBeGreaterThanOrEqual(Date.parse('2026-10-31T23:50:00Z'));

    const live = await prisma.$transaction((tx) => pnlLines(tx, '2026-10', { excludeSim: false }));
    expect(live).toEqual(closes[0].totals);
    expect(summary.contribution['2026-10']).toBe(live.contribution);

    expect(await prisma.scanInbox.count({ where: { result: null } })).toBe(0);
    expect(summary.bundles).toBe(await prisma.bundle.count());
    expect(summary.postings).toBe(await prisma.posting.count());
    // 12 slow ticks either side of 240 at the live pace.
    expect(summary.ticks).toBe(264);
    expect(summary.pace).toBeCloseTo(0.05);
    expect(summary.boundaryPace).toBe(1);
    // The clock moves between moves, so a 5 min tick's events are not one instant.
    const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT COUNT(DISTINCT "correctedAt")::int AS n FROM "BundleEvent"
      WHERE "correctedAt" >= '2026-10-31T22:00:00Z' AND "correctedAt" < '2026-10-31T23:00:00Z'`;
    expect(n).toBeGreaterThan(12);
    const bundles = await expectBundlesFollowRules(prisma);
    expect(bundles.length).toBeGreaterThan(20);
  }, 10 * 60_000);

  it('refuses a second run once the line has bundles', async () => {
    process.env.SEED_MODE = '1';
    await expect(run()).rejects.toThrow('Bundle table is not empty');
  });
});
