import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { POLO_ROUTE } from '../src/line/line';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

process.env.ADMIN_JWT_SECRET ??= 'test-only-admin-jwt-secret';

describe('admin reads and writes', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  let cookie: string;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const http = () => request(api.getHttpServer());
  const get = (path: string) => http().get(path);
  const post = (path: string) => http().post(path).set('Cookie', cookie);
  const applied = (code: string, n = 1) => async () =>
    (await prisma.scanInbox.count({ where: { bundleCode: code, result: 'applied' } })) >= n || undefined;

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    prisma = new PrismaClient();
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: { passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
      create: { login: 'tahmid', passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
    });
    api = await bootApi(clock);
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    const login = await http()
      .post('/admin/login')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ login: 'tahmid', password: 'right-password' })
      .expect(200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  it('reads the floor: the 8 route ops in order, waiting, done today, rate in force', async () => {
    const g = await makeGuest(api, clock, ['S-07']);
    await g.batch('S-07', [g.ev(1, g.codes[0], 'sew_collar', 2000)]).expect(201);
    await until(applied(g.codes[0]));

    const res = await get('/admin/floor').expect(200);
    expect(res.body.ops.map((o: { op: string }) => o.op)).toEqual(POLO_ROUTE);
    const op = (name: string) => res.body.ops.find((o: { op: string }) => o.op === name);
    expect(op('sew_collar')).toEqual({ op: 'sew_collar', waiting: 2, doneToday: 1, rateMills: 15, gate: false });
    expect(op('sew_sleeve')).toMatchObject({ waiting: 1, doneToday: 0, rateMills: 12, gate: false });
    expect(op('cut')).toMatchObject({ doneToday: 3, rateMills: 10, gate: true });
    expect(op('qc_final')).toMatchObject({ rateMills: 0, gate: true });
    expect(op('ship')).toMatchObject({ rateMills: 0, gate: true });
    expect(res.body.visitors).toBe(1);
    expect(typeof res.body.simOn).toBe('boolean');
    expect(res.body.tail.length).toBeLessThanOrEqual(10);
    expect(res.body.tail.some((t: string) => /^batch dev-S07 /.test(t))).toBe(true);
  });

  it('counts only visitors active in the last 5 minutes, and doneToday only since midnight UTC', async () => {
    clock.advance(6 * 60_000);
    expect((await get('/admin/floor').expect(200)).body.visitors).toBe(0);
    clock.set(new Date('2026-11-10T00:01:00Z'));
    const res = await get('/admin/floor').expect(200);
    expect(res.body.ops.find((o: { op: string }) => o.op === 'sew_collar').doneToday).toBe(0);
    clock.set(new Date('2026-11-09T10:10:00Z'));
  });

  it('only shows a view to the roles that may see it', async () => {
    await get('/admin/floor?as=operator').expect(200);
    await get('/admin/held?as=operator').expect(403);
    await get('/admin/audit?as=accounts').expect(200);
    await get('/admin/bundles?as=storekeeper').expect(403);
  });

  it('lists bundles with an owner and a prefix filter, and a timeline with every event and its result', async () => {
    const g = await makeGuest(api, clock, ['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.batch('S-07', [g.ev(1, code, 'sew_collar', 4000)]).expect(201);
    await until(applied(code));
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'collar' }).expect(200);
    clock.advance(1000);
    await g.batch('S-08', [g.ev(2, code, 'sew_sleeve', 0)]).expect(201);

    const list = await get('/admin/bundles').expect(200);
    expect(list.body.length).toBeLessThanOrEqual(50);
    const row = list.body.find((b: { code: string }) => b.code === code);
    expect(row).toEqual({ code, status: 'rework', nextOp: 'sew_sleeve', round: 0, owner: g.name, wastedMills: 0 });
    expect(list.body.some((b: { owner: string }) => b.owner === 'sim')).toBe(false);

    const filtered = await get(`/admin/bundles?q=${code.slice(0, 6)}`).expect(200);
    expect(filtered.body.every((b: { code: string }) => b.code.startsWith(code.slice(0, 6)))).toBe(true);
    expect((await get('/admin/bundles?q=Z-').expect(200)).body).toEqual([]);

    const t = await get(`/admin/bundles/${code}`).expect(200);
    expect(t.body.code).toBe(code);
    const byOp = (op: string) => t.body.events.filter((e: { op: string }) => e.op === op);
    expect(byOp('cut')[0]).toMatchObject({ source: 'gate', device: 'dev-C01', deviceKind: 'sim', result: 'applied' });
    expect(byOp('sew_collar')[0]).toMatchObject({
      source: 'batch',
      device: 'dev-S07',
      deviceKind: 'guest',
      result: 'applied',
      postedMills: 300,
    });
    expect(byOp('sew_collar')[0].scannedAt).toBeLessThan(byOp('sew_collar')[0].receivedAt);
    expect(byOp('qc_flag')[0]).toMatchObject({ source: 'gate', device: 'dev-Q01', result: 'applied' });
    expect(byOp('sew_sleeve')[0]).toMatchObject({ source: 'batch', result: 'rejected(rework)', wasted: false });
    expect(JSON.stringify(t.body)).not.toContain(g.devices['S-07']);
  });

  it('answers 404 for a bundle code that does not exist', async () => {
    await get('/admin/bundles/B-0000').expect(404);
  });

  it('lists held events with their age and marks the ones held past 24 h as stuck', async () => {
    const g = await makeGuest(api, clock, ['S-07', 'S-08']);
    const code = g.codes[0];
    // sew_sleeve before sew_collar is applied: it waits as held.
    await g.batch('S-08', [g.ev(1, code, 'sew_sleeve', 1000)]).expect(201);
    await until(async () => (await prisma.heldEvent.count()) > 0 || undefined);
    clock.advance(30_000);
    const first = (await get('/admin/held').expect(200)).body.find((h: { code: string }) => h.code === code);
    expect(first).toMatchObject({ code, op: 'sew_sleeve', device: 'dev-S08', ageSec: 30, stuck: false });

    clock.advance(24 * 3600_000);
    const later = (await get('/admin/held').expect(200)).body.find((h: { code: string }) => h.code === code);
    expect(later.stuck).toBe(true);
    clock.set(new Date('2026-11-09T10:30:00Z'));
  });

  it('lists devices with offline-for in seconds and never a raw device id or the sim key', async () => {
    const g = await makeGuest(api, clock, ['S-09']);
    await g.batch('S-09', []).expect(201);
    clock.advance(42_000);
    const res = await get('/admin/stations').expect(200);
    const mine = res.body.find((d: { device: string; guest?: string }) => d.guest === g.name);
    expect(mine).toMatchObject({ device: 'dev-S09', kind: 'guest', offlineFor: 42, lastPending: 0 });
    expect(typeof mine.clockOffsetMs).toBe('number');
    const never = res.body.find((d: { kind: string; offlineFor: number | null }) => d.kind === 'sim' && d.offlineFor === null);
    expect(never).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain(g.devices['S-09']);
  });

  it('refuses a rate change without the admin cookie and a bad body with 400', async () => {
    await http().post('/admin/rates').send({ op: 'hem', ratePerPieceMills: 9, effectiveFrom: '2026-12-01' }).expect(401);
    const bad = (body: object) => post('/admin/rates').send(body);
    await bad({ op: 'qc_final', ratePerPieceMills: 9, effectiveFrom: '2026-12-01' }).expect(400);
    await bad({ op: 'nope', ratePerPieceMills: 9, effectiveFrom: '2026-12-01' }).expect(400);
    await bad({ op: 'hem', ratePerPieceMills: 9, effectiveFrom: 'next week' }).expect(400);
    await bad({ op: 'hem', ratePerPieceMills: 9.5, effectiveFrom: '2026-12-01' }).expect(400);
    await bad({ op: 'hem', ratePerPieceMills: 9 }).expect(400);
  });

  it('audits a rate change with before and after, and an earlier scan keeps its old price', async () => {
    const g = await makeGuest(api, clock, ['S-07']);
    const [early, late] = [g.codes[0], g.codes[1]];
    await g.batch('S-07', [g.ev(1, early, 'sew_collar', 2000)]).expect(201);
    await until(applied(early));

    const from = new Date(clock.now().getTime() + 60_000).toISOString();
    await post('/admin/rates').send({ op: 'sew_collar', ratePerPieceMills: 20, effectiveFrom: from }).expect(201);

    const rows = await prisma.pieceRate.findMany({ where: { op: 'sew_collar' } });
    expect(rows.map((r) => r.ratePerPieceMills).sort()).toEqual([15, 20]);
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'rate_change' } });
    expect(log).toMatchObject({ actor: 'tahmid', role: 'admin', entity: 'rate:sew_collar' });
    expect(log.before).toMatchObject({ ratePerPieceMills: 15 });
    expect(log.after).toMatchObject({ ratePerPieceMills: 20, effectiveFrom: from });

    // The same instant twice would leave two rows that tie for "in force".
    await post('/admin/rates').send({ op: 'sew_collar', ratePerPieceMills: 21, effectiveFrom: from }).expect(409);

    clock.advance(120_000);
    await g.batch('S-07', [g.ev(2, late, 'sew_collar', 0)]).expect(201);
    await until(applied(late));
    const price = async (code: string) =>
      (await prisma.posting.findFirstOrThrow({ where: { bundleCode: code, eventId: { not: null }, amountMills: { in: [300, 400] } } })).amountMills;
    expect(await price(early)).toBe(300);
    expect(await price(late)).toBe(400);
    expect((await get('/admin/floor').expect(200)).body.ops.find((o: { op: string }) => o.op === 'sew_collar').rateMills).toBe(20);
  });

  it('filters the audit by action, newest first, at most 100', async () => {
    const res = await get('/admin/audit?action=rate_change').expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ action: 'rate_change', actor: 'tahmid' });
    const all = (await get('/admin/audit').expect(200)).body;
    expect(all.length).toBeLessThanOrEqual(100);
  });

  it('resets guest and sim data of this month, keeps earlier months, audit and line data', async () => {
    await prisma.posting.create({
      data: { period: '2026-10', kind: 'labour', amountMills: 777, bundleCode: 'B-1001', guestPurged: true },
    });
    await prisma.posting.create({
      data: { period: '2026-11', kind: 'labour', amountMills: 555, bundleCode: 'B-1002', isSimulated: true },
    });
    const octoberBefore = await prisma.posting.aggregate({ where: { period: '2026-10' }, _sum: { amountMills: true } });
    const auditBefore = await prisma.auditLog.count();

    await http().post('/admin/reset').expect(401);
    await post('/admin/reset').expect(201);

    expect(await prisma.guest.count()).toBe(0);
    expect(await prisma.device.count({ where: { guestId: { not: null } } })).toBe(0);
    expect(await prisma.bundle.count()).toBe(0);
    expect(await prisma.bundleEvent.count()).toBe(0);
    expect(await prisma.scanInbox.count()).toBe(0);
    expect(await prisma.heldEvent.count()).toBe(0);
    expect(await prisma.deviceNotice.count()).toBe(0);
    expect(await prisma.posting.count({ where: { period: '2026-11' } })).toBe(0);
    expect(await prisma.posting.aggregate({ where: { period: '2026-10' }, _sum: { amountMills: true } })).toEqual(octoberBefore);
    expect(await prisma.auditLog.count()).toBe(auditBefore + 1);
    expect(await prisma.auditLog.count({ where: { action: 'reset' } })).toBe(1);
    expect(await prisma.user.count()).toBe(1);
    expect(await prisma.style.count()).toBe(1);
    expect(await prisma.pieceRate.count()).toBeGreaterThanOrEqual(7);
    expect(await prisma.device.count({ where: { isSimulated: true } })).toBeGreaterThan(0);
  });
});
