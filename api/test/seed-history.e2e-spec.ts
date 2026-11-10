import { PrismaClient } from '@prisma/client';
import { FixedClock } from '../src/clock';
import { CloseService } from '../src/money/close.service';
import { pnlLines } from '../src/money/pnl';
import { closeWhenSettled, runHistory } from '../src/seed-history';
import { bootApi, emptyStock, expectBundlesFollowRules, purgeQueues, resetDb } from './helpers';

// Four hours across the end of October at the seed's own settings: 5 min
// ticks of 5 moves, and the live pace from 23:00 to 01:00, so the close at
// 00:05 and S-09's scripted outage both fall inside the run. It ends 2 min
// past a tick, so the last tick is cut short at until.
const UNTIL = new Date('2026-11-01T02:02:00Z');
const run = () =>
  runHistory({
    from: new Date('2026-10-31T22:00:00Z'),
    until: () => UNTIL,
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

  // resetDb stocks the store; the run seeds the line and its rolls itself.
  it('refuses while the stock ledger holds anything', async () => {
    process.env.SEED_MODE = '1';
    await expect(run()).rejects.toThrow('the Roll table is not empty');
    expect(await prisma.bundle.count()).toBe(0);
  });

  it('runs the sim across the month end, closes October once at 00:05 and books S-09 late', async () => {
    process.env.SEED_MODE = '1';
    await emptyStock();
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
    // 12 slow ticks either side of 240 at the live pace, and the 2 min one.
    expect(summary.ticks).toBe(265);
    expect(Math.round(summary.simDays * 24 * 60)).toBe(4 * 60 + 2);
    const last = await prisma.bundleEvent.aggregate({ _max: { correctedAt: true } });
    expect(last._max.correctedAt!.getTime()).toBeLessThanOrEqual(UNTIL.getTime());
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

  // A scan the worker has not settled would land after the snapshot as a
  // late scan that never was, so the run stops instead of closing.
  it('will not close a month while a scan is unsettled', async () => {
    const api = await bootApi(new FixedClock(new Date('2026-12-01T00:10:00Z')));
    const device = await prisma.device.findFirstOrThrow({ where: { isSimulated: true, code: 'S-07' } });
    const at = new Date('2026-11-30T23:59:00Z');
    const row = await prisma.scanInbox.create({
      data: { deviceId: device.id, seq: 1_000_000, bundleCode: 'B-0000', op: 'sew_collar', scannedAt: at, offsetMs: 0, correctedAt: at },
    });
    try {
      await expect(closeWhenSettled(prisma, api.get(CloseService), '2026-11', 200)).rejects.toThrow(
        'not closing 2026-11: the worker has scans it has not settled',
      );
      expect(await prisma.periodClose.findUnique({ where: { period: '2026-11' } })).toBeNull();
    } finally {
      await prisma.scanInbox.delete({ where: { id: row.id } });
      await api.close();
    }
  });
});
