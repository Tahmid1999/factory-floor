import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PostingKind, PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { HoodService } from '../src/hood/hood';
import { closeMonth } from '../src/money/close';
import { CloseService } from '../src/money/close.service';
import { pnlLines } from '../src/money/pnl';
import { post } from '../src/money/postings';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

process.env.ADMIN_JWT_SECRET ??= 'test-only-admin-jwt-secret';

const CLOSE_AT = new Date('2026-11-01T00:05:00Z');

describe('month close', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  const clock = new FixedClock(CLOSE_AT);
  const http = () => request(api.getHttpServer());
  const closeRoute = (period: unknown) =>
    http().post('/admin/close').set('Cookie', cookie).set('x-forwarded-for', '203.0.113.60').send({ period });

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaClient();
    api = await bootApi(clock);
  });

  beforeEach(async () => {
    await resetDb();
    clock.set(CLOSE_AT);
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: { passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
      create: { login: 'tahmid', passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
    });
    const login = await http()
      .post('/admin/login')
      .set('x-forwarded-for', '203.0.113.61')
      .send({ login: 'tahmid', password: 'right-password' })
      .expect(200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await api.close();
  });

  const at = (iso: string) => new Date(iso);
  const book = (kind: PostingKind, amountMills: number, when: string, o: { isSimulated?: boolean; now?: Date } = {}) =>
    prisma.$transaction((tx) =>
      post(tx, o.now ?? clock.now(), {
        kind,
        amountMills,
        at: at(when),
        bundleCode: null,
        isSimulated: o.isSimulated ?? false,
      }),
    );

  // A bundle with the events named, each event's postings booked through
  // post() as the real steps book them, against the event's own id.
  async function bundleWith(
    code: string,
    isSimulated: boolean,
    events: { op: string; at: string; postings?: [PostingKind, number][] }[],
  ) {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const b = await prisma.bundle.create({
      data: { code, styleId: style.id, pieces: 20, status: 'active', isSimulated },
    });
    for (const e of events) {
      const ev = await prisma.bundleEvent.create({
        data: { bundleId: b.id, op: e.op, source: 'gate', round: 0, correctedAt: at(e.at), isSimulated },
      });
      for (const [kind, amountMills] of e.postings ?? []) {
        await prisma.$transaction((tx) =>
          post(tx, clock.now(), { kind, amountMills, at: at(e.at), bundleCode: code, eventId: ev.id, isSimulated }),
        );
      }
    }
    return b;
  }

  describe('pnlLines', () => {
    it('keeps own-month lines apart from late rows, signs the late rows, and never subtracts the write-off', async () => {
      await book('revenue', 84_000, '2026-10-20T10:00:00Z');
      await book('fabric', 61_200, '2026-10-20T10:00:00Z');
      await book('trims', 290, '2026-10-20T10:00:00Z');
      await book('labour', 1240, '2026-10-20T10:00:00Z');
      await book('adjustment', -3400, '2026-10-21T10:00:00Z');
      await book('writeoff', 9999, '2026-10-22T10:00:00Z');
      await book('labour', 500, '2026-10-22T10:00:00Z', { isSimulated: true });
      await prisma.periodClose.create({
        data: { period: '2026-09', closedAt: CLOSE_AT, closedBy: 'test', wipMills: 0, wipGuestMills: 0, totals: {} },
      });
      // Dated into closed September, so booked in October as late rows.
      await book('labour', 300, '2026-09-30T23:58:00Z', { now: at('2026-10-02T00:00:00Z') });
      await book('revenue', 84_000, '2026-09-30T23:59:00Z', { now: at('2026-10-02T00:00:00Z') });
      await book('writeoff', 700, '2026-09-30T23:59:00Z', { now: at('2026-10-02T00:00:00Z') });

      const all = await prisma.$transaction((tx) => pnlLines(tx, '2026-10', { excludeSim: false }));
      expect(all).toEqual({
        revenue: 84_000,
        fabric: 61_200,
        trims: 290,
        labour: 1740,
        adjustment: -3400,
        late: [{ from: '2026-09', mills: 84_000 - 300 }],
        contribution: 84_000 + 84_000 - (61_200 + 290 + 1740 + 300 - 3400),
        writeoff: 9999,
      });

      const guest = await prisma.$transaction((tx) => pnlLines(tx, '2026-10', { excludeSim: true }));
      expect(guest.labour).toBe(1240);
      expect(guest.contribution).toBe(all.contribution + 500);
    });

    it('reads an empty month as zeros', async () => {
      const lines = await prisma.$transaction((tx) => pnlLines(tx, '2026-08', { excludeSim: false }));
      expect(lines).toEqual({
        revenue: 0,
        fabric: 0,
        trims: 0,
        labour: 0,
        adjustment: 0,
        late: [],
        contribution: 0,
        writeoff: 0,
      });
    });
  });

  it('closes a month once: the second call answers closed false and leaves one row and one audit row', async () => {
    await book('labour', 1240, '2026-10-20T10:00:00Z');
    const first = await closeRoute('2026-10').expect(201);
    expect(first.body).toMatchObject({ closed: true, close: { period: '2026-10', closedBy: 'tahmid' } });
    expect(first.body.close.totals.labour).toBe(1240);
    const second = await closeRoute('2026-10').expect(201);
    expect(second.body.closed).toBe(false);
    expect(second.body.close.closedAt).toBe(first.body.close.closedAt);
    expect(await prisma.periodClose.count()).toBe(1);
    const rows = await prisma.auditLog.findMany({ where: { action: 'month_close' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'tahmid', role: 'admin', entity: 'period:2026-10' });
  });

  it('refuses the current month and any later one with 400 month not over', async () => {
    const r = await closeRoute('2026-11').expect(400);
    expect(r.body.error).toBe('month not over');
    await closeRoute('2026-12').expect(400);
    await expect(prisma.$transaction((tx) => closeMonth(tx, CLOSE_AT, '2026-11', 'tahmid'))).rejects.toMatchObject({
      response: { error: 'month not over' },
    });
    expect(await prisma.periodClose.count()).toBe(0);
  });

  it('refuses a period that is not YYYY-MM', async () => {
    await closeRoute('2026-13').expect(400);
    await closeRoute('Oct').expect(400);
    await closeRoute(undefined).expect(400);
  });

  it('needs the admin login', async () => {
    await http().post('/admin/close').set('x-forwarded-for', '203.0.113.62').send({ period: '2026-10' }).expect(401);
  });

  it('values wip at the end of the month: shipped after it counts, shipped or scrapped before it does not', async () => {
    const cutCost: [PostingKind, number][] = [
      ['labour', 200],
      ['fabric', 61_200],
    ];
    // Guest bundle, cut Oct 30, sewn Oct 31, sewn again and shipped Nov 1.
    await bundleWith('B-9001', false, [
      { op: 'cut', at: '2026-10-30T10:00:00Z', postings: cutCost },
      { op: 'sew_sleeve', at: '2026-10-31T10:00:00Z', postings: [['labour', 240], ['trims', 290]] },
      { op: 'hem', at: '2026-11-01T00:01:00Z', postings: [['labour', 160]] },
      { op: 'ship', at: '2026-11-01T00:02:00Z', postings: [['revenue', 84_000]] },
    ]);
    // Sim bundle still on the line.
    await bundleWith('B-9002', true, [{ op: 'cut', at: '2026-10-30T11:00:00Z', postings: cutCost }]);
    // Shipped Oct 31.
    await bundleWith('B-9003', true, [
      { op: 'cut', at: '2026-10-30T12:00:00Z', postings: cutCost },
      { op: 'ship', at: '2026-10-31T23:59:59Z', postings: [['revenue', 84_000]] },
    ]);
    // Scrapped Oct 31.
    await bundleWith('B-9004', false, [
      { op: 'cut', at: '2026-10-30T12:00:00Z', postings: cutCost },
      { op: 'scrap', at: '2026-10-31T12:00:00Z', postings: [['writeoff', 61_400]] },
    ]);
    // Cut in November.
    await bundleWith('B-9005', false, [{ op: 'cut', at: '2026-11-01T00:00:00Z', postings: cutCost }]);

    const { close } = await prisma.$transaction((tx) => closeMonth(tx, CLOSE_AT, '2026-10', 'tahmid'));
    const guest = 61_400 + 240 + 290;
    expect(close.wipGuestMills).toBe(guest);
    expect(close.wipMills).toBe(guest + 61_400);
  });

  it('posts a late scan into november as an adjustment of october and leaves october as it was closed', async () => {
    await purgeQueues();
    const worker: INestApplicationContext = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    try {
      clock.set(at('2026-10-31T23:57:00Z'));
      const g = await makeGuest(api, clock, ['S-07']);
      clock.set(CLOSE_AT);
      const closed = await closeRoute('2026-10').expect(201);
      expect(closed.body.closed).toBe(true);
      // The visitor's 3 bundles, cut Oct 31 and still at sew_collar.
      expect(closed.body.close.wipGuestMills).toBe(3 * (200 + 61_200));
      const line = api
        .get(HoodService)
        .recent()
        .filter((e) => e.kind === 'close')
        .at(-1);
      expect(line?.text).toMatch(/^close 2026-10 · wip \$184\.20 · \d+ ms$/);

      // Scanned 23:58 on Oct 31, received 00:30 on Nov 1.
      clock.set(at('2026-11-01T00:30:00Z'));
      await g.batch('S-07', [g.ev(1, g.codes[0], 'sew_collar', 32 * 60_000)]).expect(201);
      const late = await until(() =>
        prisma.posting.findFirst({ where: { bundleCode: g.codes[0], kind: 'labour', adjustsPeriod: { not: null } } }),
      );
      expect(late).toMatchObject({ period: '2026-11', adjustsPeriod: '2026-10', amountMills: 300 });

      const row = await prisma.periodClose.findUniqueOrThrow({ where: { period: '2026-10' } });
      const again = await prisma.$transaction((tx) => pnlLines(tx, '2026-10', { excludeSim: false }));
      expect(again).toEqual(row.totals);
      const nov = await prisma.$transaction((tx) => pnlLines(tx, '2026-11', { excludeSim: false }));
      expect(nov.late).toEqual([{ from: '2026-10', mills: -300 }]);
    } finally {
      await worker.close();
    }
  });

  it('waits for a posting that holds october open, includes it, and sends later october work to november', async () => {
    let posted!: () => void;
    const isPosted = new Promise<void>((r) => (posted = r));
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));

    const a = prisma.$transaction(
      async (tx) => {
        await post(tx, CLOSE_AT, { kind: 'labour', amountMills: 777, at: at('2026-10-31T23:59:00Z'), bundleCode: null, isSimulated: false });
        posted();
        await barrier;
      },
      { timeout: 30_000 },
    );
    await isPosted;

    let closeDone = false;
    const c = prisma
      .$transaction((tx) => closeMonth(tx, CLOSE_AT, '2026-10', 'tahmid'), { timeout: 30_000 })
      .then((r) => {
        closeDone = true;
        return r;
      });
    // The close is queued on the advisory lock A holds shared.
    await until(async () => {
      const [{ n }] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
      return n > 0;
    });
    expect(closeDone).toBe(false);

    release();
    await a;
    const { closed, close } = await c;
    expect(closed).toBe(true);
    expect((close.totals as { labour: number }).labour).toBe(777);

    const b = await prisma.$transaction((tx) =>
      post(tx, CLOSE_AT, { kind: 'labour', amountMills: 555, at: at('2026-10-31T23:59:30Z'), bundleCode: null, isSimulated: false }),
    );
    expect(b).toMatchObject({ period: '2026-11', adjustsPeriod: '2026-10' });
  });

  it('rolls the audit row back with the close when the transaction fails after it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await closeMonth(tx, CLOSE_AT, '2026-10', 'tahmid');
        expect(await tx.auditLog.count({ where: { action: 'month_close' } })).toBe(1);
        throw new Error('after the audit insert');
      }),
    ).rejects.toThrow('after the audit insert');
    expect(await prisma.periodClose.count()).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'month_close' } })).toBe(0);
  });

  it('the hourly run closes the month before the clock as cron, and only once', async () => {
    expect(api.get(SchedulerRegistry).getCronJob('close')).toBeDefined();
    clock.set(at('2026-11-03T07:05:00Z'));
    const svc = api.get(CloseService);
    expect(await svc.runOnce()).toMatchObject({ closed: true, close: { period: '2026-10', closedBy: 'cron' } });
    expect(await svc.runOnce()).toMatchObject({ closed: false });
    const rows = await prisma.auditLog.findMany({ where: { action: 'month_close' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: 'cron', role: 'system' });
  });
});
