import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { HoodService } from '../src/hood/hood';
import { seedLine } from '../src/seed';
import { issueForBundle, issueFromRoll, onHandCm, receive } from '../src/stock/stock';
import { bootApi, emptyStock, resetDb } from './helpers';

process.env.ADMIN_JWT_SECRET ??= 'test-only-admin-jwt-secret';

let nextIp = 20;
const freshIp = () => `203.0.113.${nextIp++}`;

describe('stock ledger', () => {
  let api: INestApplication;
  let prisma: PrismaClient;
  let cookie: string;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const http = () => request(api.getHttpServer());
  const sim = (path: string) => http().post(path).set('x-sim-key', process.env.SIM_KEY!);

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaClient();
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: { passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
      create: { login: 'tahmid', passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
    });
    api = await bootApi(clock);
    const login = await http()
      .post('/admin/login')
      .set('x-forwarded-for', '203.0.113.9')
      .send({ login: 'tahmid', password: 'right-password' })
      .expect(200);
    cookie = login.headers['set-cookie'][0].split(';')[0];
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await api.close();
  });

  const rollOf = (code: string) => prisma.roll.findUniqueOrThrow({ where: { code } });
  const onHand = async (code: string) => prisma.$transaction(async (tx) => onHandCm(tx, (await rollOf(code)).id));
  const counts = async () => ({
    bundles: await prisma.bundle.count(),
    events: await prisma.bundleEvent.count(),
    postings: await prisma.posting.count(),
    movements: await prisma.stockMovement.count(),
  });

  // One fresh roll and nothing else, so a test knows where every cut goes.
  async function oneRoll(cost = 3400) {
    await emptyStock();
    const [roll] = await prisma.$transaction((tx) =>
      receive(tx, clock.now(), { count: 1, costPerMetreMills: cost, actor: 'test', isSimulated: true }),
    );
    return roll;
  }

  const cutOnce = (i: number) =>
    prisma.$transaction((tx) =>
      issueForBundle(tx, clock.now(), {
        bundleCode: `B-T${i}`,
        actor: 'test',
        isSimulated: true,
        eventId: `ev-${i}`,
        guestId: null,
      }),
    );

  it('seeds 6 opening rolls of 300 m at 3400 a metre, and seeding again adds none', async () => {
    await emptyStock();
    await seedLine(prisma);
    const rolls = await prisma.roll.findMany({ orderBy: { code: 'asc' } });
    expect(rolls).toHaveLength(6);
    for (const r of rolls) {
      expect(r).toMatchObject({ lengthCm: 30_000, costPerMetreMills: 3400, isTest: false, isSimulated: true });
      expect(await onHand(r.code)).toBe(30_000);
    }
    await seedLine(prisma);
    expect(await prisma.roll.count()).toBe(6);
    await resetDb();
  });

  it('issues 1800 cm and posts its fabric when the sim cuts a bundle', async () => {
    const cutter = (await sim('/devices').send({ station: 'C-01', simName: 'sim-cutter' }).expect(201)).body.deviceId;
    const cut = await sim('/gate/scan').send({ deviceId: cutter, gateId: randomUUID(), action: 'cut' }).expect(200);
    expect(cut.body.ok).toBe(true);
    const code = cut.body.message.replace('cut ', '');

    const moves = await prisma.stockMovement.findMany({ where: { bundleCode: code } });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ kind: 'issue_to_cutting', deltaCm: -1800, actor: 'sim-cutter', isSimulated: true });
    expect(moves[0].rollId).toBe((await rollOf('R-1001')).id);
    expect(moves[0].at).toEqual(clock.now());

    const bundle = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    const event = await prisma.bundleEvent.findFirstOrThrow({ where: { bundleId: bundle.id, op: 'cut' } });
    const fabric = await prisma.posting.findMany({ where: { bundleCode: code, kind: 'fabric' } });
    expect(fabric).toHaveLength(1);
    expect(fabric[0]).toMatchObject({ amountMills: (1800 * 3400) / 100, eventId: event.id, isSimulated: true, period: '2026-11' });
    expect(fabric[0].amountMills).toBe(61_200);
    expect(await onHand('R-1001')).toBe(28_200);
  });

  it('gives the 16th bundle on a fresh roll the whole 3000 cm left, and the 17th nothing', async () => {
    const roll = await oneRoll();
    const taken = [];
    for (let i = 0; i < 16; i++) taken.push(await cutOnce(i));
    expect(taken.slice(0, 15).every((t) => t?.cm === 1800)).toBe(true);
    expect(taken[15]).toEqual({ rollCode: roll.code, cm: 3000, mills: 102_000 });
    expect(await onHand(roll.code)).toBe(0);
    expect(await cutOnce(16)).toBeNull();
  });

  it('never takes more than a roll holds when 20 cuts race on it', async () => {
    const roll = await oneRoll();
    const codes = Array.from({ length: 20 }, (_, i) => `B-T${100 + i}`);
    const results = await Promise.all(codes.map((_, i) => cutOnce(100 + i)));
    const taken = results.filter((r) => r !== null);
    expect(taken).toHaveLength(16);
    expect(taken.reduce((n, t) => n + t!.cm, 0)).toBe(30_000);
    expect(await onHand(roll.code)).toBe(0);
    const issues = await prisma.stockMovement.findMany({ where: { rollId: roll.id, kind: 'issue_to_cutting' } });
    expect(issues).toHaveLength(16);
    expect(await prisma.posting.count({ where: { kind: 'fabric', bundleCode: { in: codes } } })).toBe(16);
  });

  it('moves a cut that lost the race on to the next roll', async () => {
    const older = await oneRoll();
    const [newer] = await prisma.$transaction((tx) =>
      receive(tx, new Date(clock.now().getTime() + 1000), { count: 1, costPerMetreMills: 3200, actor: 'test', isSimulated: true }),
    );
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cutOnce(200 + i)));
    expect(results.every((r) => r !== null)).toBe(true);
    // The older roll empties first; the cuts after it go to the newer one.
    expect(results.filter((r) => r!.rollCode === older.code)).toHaveLength(16);
    const moved = results.filter((r) => r!.rollCode === newer.code);
    expect(moved).toHaveLength(4);
    expect(moved.every((r) => r!.cm === 1800 && r!.mills === 57_600)).toBe(true);
    expect(await onHand(older.code)).toBe(0);
    expect(await onHand(newer.code)).toBe(30_000 - 4 * 1800);
  });

  it('lets 10 of 20 concurrent 10 m issues through on a 100 m test roll and refuses the rest', async () => {
    const postings = await prisma.posting.count();
    const res = await http().post('/admin/stock/stress').set('x-forwarded-for', freshIp()).expect(201);
    expect(res.body).toEqual({ roll: expect.stringMatching(/^T-\d{4}$/), accepted: 10, refused: 10, onHandCm: 0, ms: expect.any(Number) });

    const roll = await rollOf(res.body.roll);
    expect(roll).toMatchObject({ isTest: true, lengthCm: 10_000 });
    const issues = await prisma.stockMovement.findMany({ where: { rollId: roll.id, kind: 'issue_to_cutting' } });
    expect(issues).toHaveLength(10);
    expect(issues.every((m) => m.deltaCm === -1000 && m.actor === 'stress' && m.bundleCode === null)).toBe(true);
    expect(issues.reduce((n, m) => n + m.deltaCm, 0) + 10_000).toBe(0);
    expect(await onHand(res.body.roll)).toBe(0);
    // No money moves for a test roll.
    expect(await prisma.posting.count()).toBe(postings);

    const line = api.get(HoodService).recent().find((e) => e.kind === 'stress');
    expect(line?.text).toMatch(new RegExp(`^stress ${res.body.roll} · 10 taken · 10 refused · \\d+ ms$`));
  });

  it('keeps the test roll at exactly 0 and the real rolls whole while stress and real cuts run at once', async () => {
    await resetDb();
    const before = await prisma.$transaction(async (tx) => {
      const rolls = await tx.roll.findMany({ where: { isTest: false } });
      return Promise.all(rolls.map(async (r) => [r.code, await onHandCm(tx, r.id)] as const));
    });
    const [stress, ...cuts] = await Promise.all([
      http().post('/admin/stock/stress').set('x-forwarded-for', freshIp()).expect(201),
      ...Array.from({ length: 5 }, (_, i) => cutOnce(300 + i)),
    ]);
    expect((stress as request.Response).body).toMatchObject({ accepted: 10, refused: 10, onHandCm: 0 });
    expect(cuts.every((c) => c && c.rollCode === 'R-1001' && c.cm === 1800)).toBe(true);
    expect(await onHand('R-1001')).toBe(30_000 - 5 * 1800);
    for (const [code, cm] of before) if (code !== 'R-1001') expect(await onHand(code)).toBe(cm);
    // Every fabric posting is a real cut's.
    expect(await prisma.posting.count({ where: { kind: 'fabric' } })).toBe(5);
    const testRoll = await rollOf((stress as request.Response).body.roll);
    const moves = await prisma.stockMovement.findMany({ where: { rollId: testRoll.id }, orderBy: { id: 'asc' } });
    let running = 0;
    for (const m of moves) {
      running += m.deltaCm;
      expect(running).toBeGreaterThanOrEqual(0);
    }
    expect(running).toBe(0);
  });

  it('refuses a second stress run from one address inside a minute', async () => {
    const ip = freshIp();
    await http().post('/admin/stock/stress').set('x-forwarded-for', ip).expect(201);
    const again = await http().post('/admin/stock/stress').set('x-forwarded-for', ip).expect(429);
    expect(again.body.error).toEqual(expect.any(String));
  });

  it('refuses an issue the roll cannot cover and takes nothing', async () => {
    const roll = await oneRoll();
    expect(await prisma.$transaction((tx) => issueFromRoll(tx, clock.now(), roll.id, 30_001, 'test'))).toBe(false);
    expect(await prisma.$transaction((tx) => issueFromRoll(tx, clock.now(), roll.id, 30_000, 'test'))).toBe(true);
    expect(await onHand(roll.code)).toBe(0);
  });

  it('lists real rolls with on-hand and a roll\'s movements, and leaves test rolls out', async () => {
    await resetDb();
    await http().post('/admin/stock/stress').set('x-forwarded-for', freshIp()).expect(201);
    await cutOnce(400);
    const res = await http().get('/admin/stock').expect(200);
    const real = await prisma.roll.count({ where: { isTest: false } });
    expect(res.body).toHaveLength(real);
    expect(res.body.every((r: { code: string }) => r.code.startsWith('R-'))).toBe(true);
    expect(res.body.find((r: { code: string }) => r.code === 'R-1001')).toEqual({
      code: 'R-1001',
      lengthCm: 30_000,
      onHandCm: 28_200,
      costPerMetreMills: 3400,
      receivedAt: expect.any(Number),
      isSimulated: true,
    });
    await http().get('/admin/stock?as=storekeeper').expect(200);
    await http().get('/admin/stock?as=accounts').expect(403);

    const moves = await http().get('/admin/stock/R-1001/movements?as=storekeeper').expect(200);
    expect(moves.body.map((m: { kind: string; deltaCm: number }) => [m.kind, m.deltaCm])).toEqual([
      ['receive', 30_000],
      ['issue_to_cutting', -1800],
    ]);
    await http().get('/admin/stock/R-9999/movements').expect(404);
  });

  it('adjusts a roll as admin with one movement, one posting and one audit row', async () => {
    await resetDb();
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: {},
      create: { login: 'tahmid', passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
    });
    const before = await counts();
    const audits = await prisma.auditLog.count();
    const res = await http()
      .post('/admin/stock/adjust')
      .set('Cookie', cookie)
      .send({ rollCode: 'R-1002', deltaCm: -500, reason: 'damaged' })
      .expect(201);
    expect(res.body).toEqual({ rollCode: 'R-1002', onHandCm: 29_500, amountMills: 17_000 });

    const after = await counts();
    expect(after.movements).toBe(before.movements + 1);
    expect(after.postings).toBe(before.postings + 1);
    const roll = await rollOf('R-1002');
    const move = await prisma.stockMovement.findFirstOrThrow({ where: { rollId: roll.id, kind: 'adjust' } });
    expect(move).toMatchObject({ deltaCm: -500, reason: 'damaged', actor: 'tahmid', isSimulated: false });
    const posting = await prisma.posting.findFirstOrThrow({ where: { kind: 'adjustment' } });
    expect(posting).toMatchObject({ amountMills: 17_000, bundleCode: null, isSimulated: false, period: '2026-11' });
    expect(await prisma.auditLog.count()).toBe(audits + 1);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'stock_adjust' } });
    expect(row).toMatchObject({ actor: 'tahmid', role: 'admin', entity: 'roll:R-1002' });

    // A count that finds fabric is a gain, so its posting is negative.
    const found = await http()
      .post('/admin/stock/adjust')
      .set('Cookie', cookie)
      .send({ rollCode: 'R-1002', deltaCm: 250, reason: 'found' })
      .expect(201);
    expect(found.body).toEqual({ rollCode: 'R-1002', onHandCm: 29_750, amountMills: -8500 });

    const line = api.get(HoodService).recent().find((e) => e.kind === 'stock' && e.text.includes('R-1002'));
    expect(line?.text).toBe('stock adjust R-1002 -500 cm damaged');
  });

  it('refuses an adjust without the login, a bad body, and one that would leave the roll below 0', async () => {
    const before = await counts();
    const res = await http()
      .post('/admin/stock/adjust?as=storekeeper')
      .send({ rollCode: 'R-1003', deltaCm: -500, reason: 'damaged' });
    expect([401, 403]).toContain(res.status);
    const adjust = (body: object) => http().post('/admin/stock/adjust').set('Cookie', cookie).send(body);
    await adjust({ rollCode: 'R-1003', deltaCm: -500, reason: 'stolen' }).expect(400);
    await adjust({ rollCode: 'R-1003', deltaCm: 0, reason: 'count' }).expect(400);
    await adjust({ rollCode: 'R-1003', deltaCm: 1.5, reason: 'count' }).expect(400);
    await adjust({ rollCode: 'R-1003', deltaCm: 500, reason: 'damaged' }).expect(400);
    await adjust({ rollCode: 'R-9999', deltaCm: -500, reason: 'count' }).expect(404);
    await adjust({ rollCode: 'R-1003', deltaCm: -30_001, reason: 'count' }).expect(409);
    expect(await counts()).toEqual(before);
  });

  it('marks a roll emptied by its last cut, skips it, and clears the mark when an adjust adds fabric back', async () => {
    const first = await oneRoll();
    expect(first.emptiedAt).toBeNull();
    const [second] = await prisma.$transaction((tx) =>
      receive(tx, new Date(clock.now().getTime() + 1000), { count: 1, costPerMetreMills: 3400, actor: 'test', isSimulated: true }),
    );
    for (let i = 0; i < 16; i++) expect((await cutOnce(600 + i))?.rollCode).toBe(first.code);
    expect((await rollOf(first.code)).emptiedAt).toEqual(clock.now());
    expect((await rollOf(second.code)).emptiedAt).toBeNull();
    expect((await cutOnce(616))?.rollCode).toBe(second.code);
    const sims = await http().get('/sim/stock').set('x-sim-key', process.env.SIM_KEY!).expect(200);
    expect(sims.body).toEqual({ cuttableRolls: 1 });

    await http()
      .post('/admin/stock/adjust')
      .set('Cookie', cookie)
      .send({ rollCode: first.code, deltaCm: 500, reason: 'found' })
      .expect(201);
    expect((await rollOf(first.code)).emptiedAt).toBeNull();
    expect(await onHand(first.code)).toBe(500);
    const listed = (await http().get('/admin/stock').expect(200)).body;
    expect(listed.find((r: { code: string }) => r.code === first.code).onHandCm).toBe(500);

    await http()
      .post('/admin/stock/adjust')
      .set('Cookie', cookie)
      .send({ rollCode: first.code, deltaCm: -500, reason: 'count' })
      .expect(201);
    expect((await rollOf(first.code)).emptiedAt).toEqual(clock.now());
    expect((await http().get('/admin/stock').expect(200)).body.find((r: { code: string }) => r.code === first.code).onHandCm).toBe(0);
    await resetDb();
  });

  it('marks a stress test roll emptied when its last 10 m goes', async () => {
    const res = await http().post('/admin/stock/stress').set('x-forwarded-for', freshIp()).expect(201);
    expect((await rollOf(res.body.roll)).emptiedAt).toEqual(clock.now());
  });

  it('leaves the stock ledger alone on a demo reset', async () => {
    await cutOnce(500);
    const moves = await prisma.stockMovement.count();
    const r1 = await onHand('R-1001');
    await http().post('/admin/reset').set('Cookie', cookie).expect(201);
    expect(await prisma.stockMovement.count()).toBe(moves);
    expect(await onHand('R-1001')).toBe(r1);
  });

  it('receives rolls for the sim only, numbered on from the last', async () => {
    await http().post('/stock/receive').send({ count: 6, costPerMetreMills: 3400 }).expect(404);
    const before = await prisma.roll.count({ where: { isTest: false } });
    const res = await sim('/stock/receive').send({ count: 2, costPerMetreMills: 3250 }).expect(201);
    expect(res.body.rolls).toHaveLength(2);
    expect(await prisma.roll.count({ where: { isTest: false } })).toBe(before + 2);
    await sim('/stock/receive').send({ count: 2, costPerMetreMills: 3333 }).expect(400);
    await sim('/stock/receive').send({ count: 0, costPerMetreMills: 3400 }).expect(400);
    const line = api.get(HoodService).recent().filter((e) => e.kind === 'stock').pop();
    expect(line?.text).toMatch(/^stock receive R-\d{4}\.\.R-\d{4} · 3250 mills\/m$/);
  });
});
