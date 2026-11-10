import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { post } from '../src/money/postings';
import { bootApi, resetDb } from './helpers';

const NOW = new Date('2026-11-11T12:00:00Z');
const DAY = '2026-11-10';

type Row = { worker: string; key: string; kind: string; pieces: number; paidPieces: number; earningsMills: number };

describe('payroll', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  const clock = new FixedClock(NOW);
  const get = (path: string) => request(api.getHttpServer()).get(path).set('x-forwarded-for', '203.0.113.91');

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

  let n = 0;
  async function work(
    deviceId: string | null,
    op: string,
    at: string,
    o: { round?: number; paid?: number; sim: boolean; guestId?: string },
  ) {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const code = `B-${8000 + n++}`;
    const b = await prisma.bundle.create({
      data: { code, styleId: style.id, pieces: 20, status: 'active', isSimulated: o.sim, guestId: o.guestId },
    });
    const ev = await prisma.bundleEvent.create({
      data: {
        bundleId: b.id,
        op,
        source: 'batch',
        deviceId,
        round: o.round ?? 0,
        correctedAt: new Date(at),
        isSimulated: o.sim,
      },
    });
    if (o.paid !== undefined) {
      await prisma.$transaction((tx) =>
        post(tx, clock.now(), {
          kind: 'labour',
          amountMills: o.paid!,
          at: new Date(at),
          bundleCode: code,
          eventId: ev.id,
          guestId: o.guestId,
          isSimulated: o.sim,
        }),
      );
    }
  }

  async function fixture() {
    const sim = await prisma.device.create({ data: { code: 'S-08', isSimulated: true, simName: 'sim-op-02' } });
    const guest = await prisma.guest.create({ data: { name: 'quiet-heron-41', ipHash: 'x', lastActiveAt: NOW } });
    const gdev = await prisma.device.create({ data: { code: 'S-08', guestId: guest.id } });
    await work(sim.id, 'sew_sleeve', `${DAY}T09:00:00Z`, { paid: 240, sim: true });
    await work(sim.id, 'hem', `${DAY}T10:00:00Z`, { paid: 160, sim: true });
    // A redo: worked, not paid.
    await work(sim.id, 'hem', `${DAY}T11:00:00Z`, { round: 1, sim: true });
    // qc_final has no piece rate, so it is not a payroll scan.
    await work(sim.id, 'qc_final', `${DAY}T11:30:00Z`, { sim: true });
    // Another day.
    await work(sim.id, 'hem', '2026-11-09T23:59:59Z', { paid: 160, sim: true });
    await work(gdev.id, 'sew_sleeve', `${DAY}T12:00:00Z`, { paid: 240, sim: false, guestId: guest.id });
    // A purged guest's labour: the posting stays, its event is gone.
    await prisma.posting.create({
      data: {
        period: '2026-11',
        kind: 'labour',
        amountMills: 150,
        bundleCode: 'B-1',
        eventId: 'gone',
        guestPurged: true,
        createdAt: new Date(`${DAY}T13:00:00Z`),
        isSimulated: false,
      },
    });
    return { sim, gdev };
  }

  const list = async (): Promise<Row[]> => (await get(`/admin/payroll?day=${DAY}`).expect(200)).body.rows;

  it('gives one row per worker with pieces, paid pieces and earnings', async () => {
    await fixture();
    const rows = await list();
    const sim = rows.find((x) => x.kind === 'sim')!;
    expect(sim).toMatchObject({ worker: 'sim-op-02', pieces: 60, paidPieces: 40, earningsMills: 400 });
    const [{ s }] = await prisma.$queryRaw<{ s: bigint }[]>`
      SELECT SUM(p."amountMills")::bigint AS s FROM "Posting" p JOIN "BundleEvent" e ON e.id = p."eventId"
      JOIN "Device" d ON d.id = e."deviceId" WHERE d."isSimulated" AND p.kind = 'labour'
        AND e."correctedAt" >= ${new Date(`${DAY}T00:00:00Z`)} AND e."correctedAt" < ${new Date('2026-11-11T00:00:00Z')}`;
    expect(sim.earningsMills).toBe(Number(s));
    const guest = rows.find((x) => x.kind === 'guest')!;
    expect(guest).toMatchObject({ pieces: 20, paidPieces: 20, earningsMills: 240 });
    expect(guest.worker).toContain('quiet-heron-41');
    expect(rows.find((x) => x.kind === 'purged')).toMatchObject({
      worker: 'purged guests',
      pieces: 0,
      paidPieces: 0,
      earningsMills: 150,
    });
    expect(rows).toHaveLength(3);
  });

  it('never shows a raw device id', async () => {
    const { sim, gdev } = await fixture();
    const text = JSON.stringify((await get(`/admin/payroll?day=${DAY}`).expect(200)).body);
    expect(text).not.toContain(sim.id);
    expect(text).not.toContain(gdev.id);
  });

  it("lists a worker's scans, an unpaid redo at 0 mills, and they total the row", async () => {
    await fixture();
    const sim = (await list()).find((x) => x.kind === 'sim')!;
    const s = (await get(`/admin/payroll/scans?day=${DAY}&worker=${encodeURIComponent(sim.key)}`).expect(200)).body;
    const scans: { at: string; bundleCode: string; op: string; round: number; pieces: number; mills: number }[] =
      s.rows;
    expect(scans).toHaveLength(3);
    expect(scans.reduce((a, x) => a + x.mills, 0)).toBe(sim.earningsMills);
    expect(scans.reduce((a, x) => a + x.pieces, 0)).toBe(sim.pieces);
    expect(scans.find((x) => x.round === 1)).toMatchObject({ op: 'hem', pieces: 20, mills: 0 });
    expect(scans.map((x) => x.at)).toEqual([...scans.map((x) => x.at)].sort());
  });

  it('lists the purged row scans-free, as earnings only', async () => {
    await fixture();
    const purged = (await list()).find((x) => x.kind === 'purged')!;
    const s = (await get(`/admin/payroll/scans?day=${DAY}&worker=${encodeURIComponent(purged.key)}`).expect(200)).body;
    expect(s.rows).toEqual([]);
  });

  it('defaults the day to today and refuses a bad one', async () => {
    const r = (await get('/admin/payroll').expect(200)).body;
    expect(r.day).toBe('2026-11-11');
    await get('/admin/payroll?day=2026-02-30').expect(400);
    await get('/admin/payroll?day=yesterday').expect(400);
    await get('/admin/payroll/scans?day=nope&worker=x').expect(400);
    await get(`/admin/payroll/scans?day=${DAY}`).expect(400);
  });

  it('lets accounts read payroll and keeps the storekeeper out', async () => {
    await get('/admin/payroll?as=accounts').expect(200);
    await get('/admin/payroll?as=storekeeper').expect(403);
    await get(`/admin/payroll/scans?day=${DAY}&worker=x&as=storekeeper`).expect(403);
  });
});
