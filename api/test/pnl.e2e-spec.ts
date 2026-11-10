import { INestApplication } from '@nestjs/common';
import { PostingKind, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { closeMonth } from '../src/money/close';
import { pnlOf, wipAt } from '../src/money/pnl';
import { post } from '../src/money/postings';
import { bootApi, resetDb } from './helpers';

const NOW = new Date('2026-11-11T12:00:00Z');

describe('month p&l', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  const clock = new FixedClock(NOW);
  const get = (path: string) => request(api.getHttpServer()).get(path).set('x-forwarded-for', '203.0.113.90');

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaClient();
    api = await bootApi(clock);
  });
  beforeEach(async () => {
    await resetDb();
    clock.set(NOW);
  });
  afterAll(async () => {
    await prisma.$disconnect();
    await api.close();
  });

  const book = (
    kind: PostingKind,
    amountMills: number,
    when: string,
    o: { sim?: boolean; now?: Date; bundleCode?: string; eventId?: string } = {},
  ) =>
    prisma.$transaction((tx) =>
      post(tx, o.now ?? clock.now(), {
        kind,
        amountMills,
        at: new Date(when),
        bundleCode: o.bundleCode ?? null,
        eventId: o.eventId,
        isSimulated: o.sim ?? false,
      }),
    );

  // October is closed, so the rows dated into it in November are late ones.
  async function mixed() {
    await book('revenue', 84_000, '2026-10-20T10:00:00Z', { now: new Date('2026-10-20T10:00:00Z') });
    await book('fabric', 61_200, '2026-10-20T10:00:00Z', { now: new Date('2026-10-20T10:00:00Z') });
    await prisma.$transaction((tx) => closeMonth(tx, new Date('2026-11-01T00:05:00Z'), '2026-10', 'test'));
    const specs: [PostingKind, number, boolean][] = [
      ['revenue', 84_000, true],
      ['revenue', 84_000, false],
      ['fabric', 61_200, true],
      ['fabric', 61_200, false],
      ['trims', 290, true],
      ['trims', 290, false],
      ['labour', 1240, true],
      ['labour', 1000, false],
      ['adjustment', -3400, false],
      ['adjustment', 2000, true],
      ['writeoff', 500, true],
    ];
    for (const [k, m, sim] of specs) await book(k, m, '2026-11-05T10:00:00Z', { sim });
    await book('labour', 300, '2026-10-31T23:00:00Z', { sim: true });
    await book('revenue', 84_000, '2026-10-31T23:00:00Z', { sim: false });
  }

  const sum = async (where = '') => {
    const [r] = await prisma.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT COALESCE(SUM(CASE WHEN kind = 'revenue' THEN "amountMills"
         WHEN kind IN ('fabric','trims','labour','adjustment') THEN -"amountMills" ELSE 0 END), 0)::bigint AS c
       FROM "Posting" WHERE "period" = '2026-11' ${where}`,
    );
    return Number(r.c);
  };

  it('sums to the contribution, and the contribution is the signed raw sum over the month', async () => {
    await mixed();
    const p = (await get('/admin/pnl?period=2026-11').expect(200)).body;
    const late = p.late.reduce((a: number, l: { mills: number }) => a + l.mills, 0);
    expect(p.late).toEqual([{ from: '2026-10', mills: 84_000 - 300 }]);
    expect(p.revenue - p.fabric - p.trims - p.labour - p.adjustment + late).toBe(p.contribution);
    expect(p.contribution).toBe(await sum());
    expect(p.closed).toBeNull();
    expect(p.writeoff).toBe(500);
  });

  it('excluding simulated rows removes exactly the sim rows, line by line', async () => {
    await mixed();
    const all = (await get('/admin/pnl?period=2026-11').expect(200)).body;
    const guest = (await get('/admin/pnl?period=2026-11&excludeSim=1').expect(200)).body;
    const [sim] = await prisma.$queryRaw<
      { revenue: bigint; fabric: bigint; trims: bigint; labour: bigint; adjustment: bigint }[]
    >`
      SELECT COALESCE(SUM("amountMills") FILTER (WHERE kind = 'revenue'), 0)::bigint AS revenue,
             COALESCE(SUM("amountMills") FILTER (WHERE kind = 'fabric'), 0)::bigint AS fabric,
             COALESCE(SUM("amountMills") FILTER (WHERE kind = 'trims'), 0)::bigint AS trims,
             COALESCE(SUM("amountMills") FILTER (WHERE kind = 'labour'), 0)::bigint AS labour,
             COALESCE(SUM("amountMills") FILTER (WHERE kind = 'adjustment'), 0)::bigint AS adjustment
      FROM "Posting" WHERE "period" = '2026-11' AND "isSimulated" AND "adjustsPeriod" IS NULL`;
    for (const k of ['revenue', 'fabric', 'trims', 'labour', 'adjustment'] as const) {
      expect(all[k] - guest[k]).toBe(Number(sim[k]));
    }
    expect(guest.late).toEqual([{ from: '2026-10', mills: 84_000 }]);
    expect(all.contribution - guest.contribution).toBe(await sum(`AND "isSimulated"`));
    expect(guest.writeoff).toBe(0);
  });

  it('a closed month reads as its snapshot, with wip as of its end', async () => {
    await mixed();
    const p = (await get('/admin/pnl?period=2026-10').expect(200)).body;
    const { totals } = await prisma.periodClose.findUniqueOrThrow({ where: { period: '2026-10' } });
    expect(p).toMatchObject(totals as object);
    expect(p.closed).toMatchObject({ period: '2026-10', closedBy: 'test' });
    expect(p.wip).toEqual({ mills: 0, asOf: '2026-11-01T00:00:00.000Z' });
  });

  it('reads the all-rows wip and the guest-only wip from different snapshot columns', async () => {
    await mixed();
    await prisma.periodClose.update({ where: { period: '2026-10' }, data: { wipMills: 700, wipGuestMills: 300 } });
    const all = (await get('/admin/pnl?period=2026-10').expect(200)).body;
    const guest = (await get('/admin/pnl?period=2026-10&excludeSim=1').expect(200)).body;
    expect(all.wip.mills).toBe(700);
    expect(guest.wip.mills).toBe(300);
  });

  it('live wip equals wipAt at now, for all rows and guest only', async () => {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const day = (h: number) => new Date(Date.UTC(2026, 10, 10, h));
    // status is what the apply and gate paths leave behind for these events.
    const fixture = async (code: string, sim: boolean, status: 'active' | 'shipped' | 'scrapped', ops: string[]) => {
      const b = await prisma.bundle.create({
        data: { code, styleId: style.id, pieces: 20, status, isSimulated: sim },
      });
      for (const [i, op] of ops.entries()) {
        const ev = await prisma.bundleEvent.create({
          data: { bundleId: b.id, op, source: 'gate', round: 0, correctedAt: day(8 + i), isSimulated: sim },
        });
        for (const [k, m] of [['labour', 200], ['fabric', 61_200], ['trims', 290]] as const) {
          await book(k, m + i, day(8 + i).toISOString(), { sim, bundleCode: code, eventId: ev.id });
        }
      }
    };
    for (const sim of [true, false]) {
      const t = sim ? 'S' : 'G';
      await fixture(`B-${t}1`, sim, 'active', ['cut', 'hem']);
      await fixture(`B-${t}2`, sim, 'shipped', ['cut', 'hem', 'ship']);
      await fixture(`B-${t}3`, sim, 'scrapped', ['cut', 'scrap']);
    }
    await prisma.bundle.create({ data: { code: 'B-uncut', styleId: style.id, pieces: 20, status: 'active', isSimulated: true } });
    const ref = await prisma.$transaction((tx) => wipAt(tx, NOW));
    expect(ref.all).toBeGreaterThan(ref.guest);
    expect(ref.guest).toBeGreaterThan(0);
    const all = (await get('/admin/pnl?period=2026-11').expect(200)).body;
    const guest = (await get('/admin/pnl?period=2026-11&excludeSim=1').expect(200)).body;
    expect(all.wip.mills).toBe(ref.all);
    expect(guest.wip.mills).toBe(ref.guest);
  });

  it('an open month shows live wip as of the clock', async () => {
    const live = (await get('/admin/pnl').expect(200)).body;
    expect(live.period).toBe('2026-11');
    expect(live.wip).toEqual({ mills: 0, asOf: NOW.toISOString() });
    expect(await prisma.$transaction((tx) => pnlOf(tx, '2026-11', { excludeSim: false, now: NOW }))).toMatchObject({
      period: '2026-11',
      closed: null,
    });
  });

  it('lists months newest first with the current one, and refuses a bad period', async () => {
    await mixed();
    const r = (await get('/admin/pnl/periods').expect(200)).body;
    expect(r).toEqual([
      { period: '2026-11', closed: false },
      { period: '2026-10', closed: true },
    ]);
    await get('/admin/pnl?period=2026-13').expect(400);
    await get('/admin/pnl?period=Nov').expect(400);
    await get('/admin/pnl/postings?kind=constructor').expect(400);
    await get('/admin/pnl/postings?kind=toString').expect(400);
  });

  it('pages the postings newest first with their bundle, op and device', async () => {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const b = await prisma.bundle.create({
      data: { code: 'B-7001', styleId: style.id, pieces: 20, status: 'active', isSimulated: true },
    });
    const dev = await prisma.device.create({ data: { code: 'S-08', isSimulated: true, simName: 'sim-op-02' } });
    const ev = await prisma.bundleEvent.create({
      data: {
        bundleId: b.id,
        op: 'sew_sleeve',
        source: 'batch',
        deviceId: dev.id,
        round: 0,
        correctedAt: NOW,
        isSimulated: true,
      },
    });
    await book('labour', 240, '2026-11-11T10:00:00Z', { sim: true, bundleCode: 'B-7001', eventId: ev.id });
    for (let i = 0; i < 104; i++) {
      clock.advance(1000);
      await book('fabric', 10 + i, '2026-11-11T10:00:00Z');
    }
    const one = (await get('/admin/pnl/postings?period=2026-11').expect(200)).body;
    expect(one.rows).toHaveLength(100);
    expect(one.next).toBe(one.rows[99].id);
    const two = (await get(`/admin/pnl/postings?period=2026-11&after=${one.next}`).expect(200)).body;
    expect(two.rows).toHaveLength(5);
    expect(two.next).toBeNull();
    const row = two.rows[4];
    expect(row).toMatchObject({
      kind: 'labour',
      amountMills: 240,
      bundleCode: 'B-7001',
      op: 'sew_sleeve',
      device: 'dev-S08',
      isSimulated: true,
    });
    expect(JSON.stringify(row)).not.toContain(dev.id);
    const labour = (await get('/admin/pnl/postings?period=2026-11&kind=labour').expect(200)).body;
    expect(labour.rows).toHaveLength(1);
  });

  it('filters postings to late rows or own-month ones', async () => {
    await mixed();
    const late = (await get('/admin/pnl/postings?period=2026-11&late=1').expect(200)).body.rows;
    expect(late).toHaveLength(2);
    expect(late.every((r: { adjustsPeriod: string | null }) => r.adjustsPeriod === '2026-10')).toBe(true);
    const own = (await get('/admin/pnl/postings?period=2026-11&late=0&excludeSim=1').expect(200)).body.rows;
    expect(own.length).toBeGreaterThan(0);
    expect(
      own.every((r: { adjustsPeriod: string | null; isSimulated: boolean }) => r.adjustsPeriod === null && !r.isSimulated),
    ).toBe(true);
  });

  it('lets accounts read the p&l and keeps the storekeeper out', async () => {
    await get('/admin/pnl?as=accounts').expect(200);
    await get('/admin/pnl/periods?as=accounts').expect(200);
    await get('/admin/pnl?as=storekeeper').expect(403);
    await get('/admin/pnl/postings?as=storekeeper').expect(403);
  });
});
