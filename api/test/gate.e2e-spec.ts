import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { APPLY_HOOKS, ApplyHooks } from '../src/apply/apply.service';
import { FixedClock } from '../src/clock';
import type { HoodEvent } from '../src/hood/hood-event';
import { POLO_ROUTE } from '../src/line/line';
import { Rabbit } from '../src/rabbit';
import { bootApi, bootWorker, purgeQueues, resetDb } from './helpers';

let nextIp = 10;
const freshIp = () => `192.0.2.${nextIp++}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(check: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await sleep(50);
  }
}

describe('gate scans', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  let hooks: ApplyHooks;
  const hood: HoodEvent[] = [];
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const now = () => clock.now().getTime();

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    hooks = worker.get(APPLY_HOOKS);
    prisma = new PrismaClient();
    await api.get(Rabbit).consumeHood((e) => hood.push(e));
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  afterEach(() => {
    hooks.beforeCommit = () => undefined;
  });

  const ev = (seq: number, bundleCode: string, op: string, agoMs: number) => ({
    seq,
    bundleCode,
    op,
    scannedAt: now() - agoMs,
    offsetMs: 0,
  });

  // A visitor with a device per station asked for, and the visitor's 3 bundles.
  async function guest(stations: string[]) {
    const agent = request.agent(api.getHttpServer());
    const ip = freshIp();
    const me = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    const devices: Record<string, string> = {};
    for (const station of stations) {
      const dev = await agent.post('/devices').set('x-forwarded-for', ip).send({ station }).expect(201);
      devices[station] = dev.body.deviceId;
    }
    clock.advance(60_000);
    const codes: string[] = me.body.bundles.map((b: { code: string }) => b.code);
    const send = (station: string, events: object[]) =>
      agent
        .post('/scans/batch')
        .set('x-forwarded-for', ip)
        .send({ deviceId: devices[station], deviceNow: now(), events })
        .expect(201);
    const gate = (station: string, body: object) =>
      agent
        .post('/gate/scan')
        .set('x-forwarded-for', ip)
        .send({ deviceId: devices[station], gateId: randomUUID(), ...body });
    const meNow = () => agent.get('/me').set('x-forwarded-for', ip).expect(200);
    return { name: me.body.name as string, devices, codes, send, gate, meNow };
  }

  const sim = (path: string) => request(api.getHttpServer()).post(path).set('x-sim-key', process.env.SIM_KEY!);
  const simDevice = async (station: string, simName: string) =>
    (await sim('/devices').send({ station, simName }).expect(201)).body.deviceId as string;
  const simGate = (deviceId: string, body: object) =>
    sim('/gate/scan').send({ deviceId, gateId: randomUUID(), ...body });

  let nextCode = 7100;
  async function simBundle(at: string, status: 'active' | 'packed' = 'active') {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    return prisma.bundle.create({
      data: {
        code: `B-${nextCode++}`,
        styleId: style.id,
        pieces: 20,
        status,
        nextStep: POLO_ROUTE.indexOf(at),
        isSimulated: true,
      },
    });
  }

  const inboxOf = (deviceId: string, seq: number) =>
    prisma.scanInbox.findUniqueOrThrow({ where: { deviceId_seq: { deviceId, seq } } });
  const resultOf = async (deviceId: string, seq: number, want: string) => {
    const row = await inboxOf(deviceId, seq);
    return row.result === want ? row : undefined;
  };

  it('sends a bundle to rework at once on a Q-01 flag, so a later batch sew_sleeve is rejected with resync and no waste', async () => {
    const g = await guest(['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 10_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));

    const flag = await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'collar' }).expect(200);
    expect(flag.body).toEqual({
      ok: true,
      status: 'rework',
      nextOp: 'sew_sleeve',
      round: 0,
      message: `${code} in rework · send back to S-07`,
      ms: expect.any(Number),
    });

    clock.advance(1000);
    const batch = await g.send('S-08', [ev(1, code, 'sew_sleeve', 0)]);
    expect(batch.body.results).toEqual([{ seq: 1, result: 'rejected', reason: 'rework' }]);
    expect(batch.body.resync).toEqual([{ bundleCode: code, status: 'rework', nextOp: 'sew_sleeve', round: 0 }]);
    const me = await g.meNow();
    expect(me.body.bundles.find((b: { code: string }) => b.code === code).wastedMills).toBe(0);

    await until(async () => hood.some((h) => h.text.startsWith(`gate Q-01 ${code} qc_flag`)), 2000);
    const line = hood.find((h) => h.text.startsWith(`gate Q-01 ${code} qc_flag`))!;
    expect(line).toMatchObject({ kind: 'gate', proc: 'api' });
    expect(line.text).toMatch(/^gate Q-01 B-\d+ qc_flag · \d+ ms$/);
  });

  it('wastes a sleeve whose corrected time is after a gate flag, and tells S-08', async () => {
    const g = await guest(['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 10_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    // A phone clock a little ahead puts the sleeve after the flag that follows.
    await g.send('S-08', [ev(7, code, 'sew_sleeve', -30_000)]);
    await until(() => resultOf(g.devices['S-08'], 7, 'applied'));

    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'sleeve' }).expect(200);
    const me = await g.meNow();
    expect(me.body.bundles.find((b: { code: string }) => b.code === code).wastedMills).toBe(530);
    const notices = await prisma.deviceNotice.findMany({ where: { bundleCode: code } });
    expect(notices.map((n) => [n.deviceId, n.seq, n.result])).toEqual([[g.devices['S-08'], 7, 'wasted']]);
  });

  it('refuses clear_rework from a QC device with the exact 403, and other wrong stations by name', async () => {
    const g = await guest(['S-07', 'Q-01', 'Q-02']);
    const code = g.codes[0];
    for (const station of ['Q-01', 'Q-02']) {
      const res = await g.gate(station, { bundleCode: code, action: 'clear_rework', targetOp: 'sew_collar' }).expect(403);
      expect(res.body).toEqual({ error: 'qc can flag rework but only a supervisor can clear it' });
    }
    const flag = await g.gate('S-07', { bundleCode: code, action: 'qc_flag', defect: 'collar' }).expect(403);
    expect(flag.body).toEqual({ error: 'S-07 cannot qc_flag' });
    const cut = await g.gate('S-07', { action: 'cut' }).expect(403);
    expect(cut.body).toEqual({ error: 'S-07 cannot cut' });
    // A refused call writes nothing, so a retry is judged afresh.
    expect(await prisma.bundleEvent.count({ where: { deviceId: { in: Object.values(g.devices) } } })).toBe(0);
  });

  it('clears rework from SUP back to sew_collar in round 1, audited once, and the redone collar is not paid again', async () => {
    const g = await guest(['S-07', 'S-09', 'Q-01', 'SUP']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 20_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    // Waits behind the sleeve; the clear must settle it, not leave it held.
    await g.send('S-09', [ev(1, code, 'side_seam', 15_000)]);
    await until(() => resultOf(g.devices['S-09'], 1, 'held'));
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'collar' }).expect(200);

    clock.advance(1000);
    const clear = await g
      .gate('SUP', { bundleCode: code, action: 'clear_rework', targetOp: 'sew_collar' })
      .expect(200);
    expect(clear.body).toMatchObject({ ok: true, status: 'active', nextOp: 'sew_collar', round: 1 });

    const b = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    expect(b).toMatchObject({ status: 'active', nextStep: POLO_ROUTE.indexOf('sew_collar'), reworkRound: 1 });
    expect(b.lastClearedAt?.getTime()).toBe(now());
    const audits = await prisma.auditLog.findMany({ where: { entity: `bundle:${code}` } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor: g.name,
      role: 'supervisor',
      action: 'clear_rework',
      before: { status: 'rework', nextStep: 'sew_sleeve', round: 0 },
      after: { status: 'active', nextStep: 'sew_collar', round: 1 },
    });
    expect((await inboxOf(g.devices['S-09'], 1)).result).toBe('rejected(stale-round)');
    expect(await prisma.heldEvent.count({ where: { bundleId: b.id } })).toBe(0);

    clock.advance(1000);
    await g.send('S-07', [ev(2, code, 'sew_collar', 0)]);
    const redo = await until(() => resultOf(g.devices['S-07'], 2, 'applied'));
    const redoEvent = await prisma.bundleEvent.findUniqueOrThrow({ where: { inboxId: redo.id } });
    expect(redoEvent.round).toBe(1);
    const paid = await prisma.posting.aggregate({ where: { eventId: redoEvent.id }, _sum: { amountMills: true } });
    expect(paid._sum.amountMills ?? 0).toBe(0);
    const collar = await prisma.posting.findMany({ where: { bundleCode: code, amountMills: 300 } });
    expect(collar).toHaveLength(1);

    await until(async () => hood.some((h) => h.text === `clear ${code} → sew_collar · round 1`), 2000);
    expect(hood.find((h) => h.text === `clear ${code} → sew_collar · round 1`)).toMatchObject({
      kind: 'clear',
      proc: 'api',
    });
  });

  it('answers a repeated gateId with the first reply and writes one event', async () => {
    const g = await guest(['S-07', 'Q-01']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 10_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));

    const gateId = randomUUID();
    const body = { gateId, bundleCode: code, action: 'qc_flag', defect: 'seam' };
    const first = await g.gate('Q-01', body).expect(200);
    clock.advance(500);
    const [second, third] = await Promise.all([g.gate('Q-01', body).expect(200), g.gate('Q-01', body).expect(200)]);
    expect(second.body).toEqual(first.body);
    expect(third.body).toEqual(first.body);
    expect(await prisma.bundleEvent.count({ where: { gateId } })).toBe(1);
    expect(first.body.message).toBe(`${code} in rework · send back to S-09`);
  });

  it('serializes a gate qc_pass behind a worker apply on the same bundle: the held pack is released, nothing lost', async () => {
    const qc = await simDevice('Q-02', 'sim-qc');
    const packer = await simDevice('P-01', 'sim-packer');
    const b = await simBundle('qc_final');
    clock.advance(60_000);

    let gateCall: Promise<request.Response> | undefined;
    let answeredWhileLocked = true;
    hooks.beforeCommit = async () => {
      hooks.beforeCommit = () => undefined;
      // The worker holds the bundle row here; the gate call must wait for it.
      let answered = false;
      gateCall = simGate(qc, { bundleCode: b.code, action: 'qc_pass' }).then((r) => {
        answered = true;
        return r;
      });
      await sleep(400);
      answeredWhileLocked = answered;
    };
    await sim('/scans/batch')
      .send({ deviceId: packer, deviceNow: now(), events: [ev(1, b.code, 'pack', 1000)] })
      .expect(201);
    await until(async () => gateCall);
    const reply = await gateCall!;

    expect(answeredWhileLocked).toBe(false);
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ok: true, status: 'packed', nextOp: 'ship', round: 0 });
    expect((await inboxOf(packer, 1)).result).toBe('applied');
    const after = await prisma.bundle.findUniqueOrThrow({ where: { id: b.id } });
    expect(after).toMatchObject({ status: 'packed', nextStep: POLO_ROUTE.indexOf('ship') });
    expect(await prisma.heldEvent.count({ where: { bundleId: b.id } })).toBe(0);
    // Both carry the same fixed-clock createdAt, so compare as a set.
    const events = await prisma.bundleEvent.findMany({ where: { bundleId: b.id } });
    expect(events.map((e) => [e.op, e.source]).sort()).toEqual([
      ['pack', 'batch'],
      ['qc_final', 'gate'],
    ]);
    const pack = await prisma.posting.findFirstOrThrow({ where: { bundleCode: b.code } });
    expect(pack).toMatchObject({ amountMills: 120, isSimulated: true });
  });

  it('answers 503 instead of waiting past the client timeout when the bundle stays locked', async () => {
    const qc = await simDevice('Q-02', 'sim-qc-slow');
    const packer = await simDevice('P-01', 'sim-packer-slow');
    const b = await simBundle('qc_final');
    clock.advance(60_000);

    let gateCall: Promise<request.Response> | undefined;
    hooks.beforeCommit = async () => {
      hooks.beforeCommit = () => undefined;
      gateCall = simGate(qc, { bundleCode: b.code, action: 'qc_pass' }).then((r) => r);
      await gateCall;
    };
    await sim('/scans/batch')
      .send({ deviceId: packer, deviceNow: now(), events: [ev(1, b.code, 'pack', 1000)] })
      .expect(201);
    await until(async () => gateCall);
    const reply = await gateCall!;
    expect(reply.status).toBe(503);
    expect(reply.body).toEqual({ error: 'bundle busy, scan again' });
    expect(await prisma.bundleEvent.count({ where: { bundleId: b.id, op: 'qc_final' } })).toBe(0);
    await until(() => resultOf(packer, 1, 'held'));
  });

  it('fails a bundle at Q-02 into rework with the defect station, and refuses qc_pass off qc_final with no event', async () => {
    const qc = await simDevice('Q-02', 'sim-qc');
    const b = await simBundle('qc_final');
    const fail = await simGate(qc, { bundleCode: b.code, action: 'qc_fail', defect: 'hem' }).expect(200);
    expect(fail.body).toMatchObject({
      ok: true,
      status: 'rework',
      nextOp: 'qc_final',
      round: 0,
      message: `${b.code} in rework · send back to S-10`,
    });

    const g = await guest(['Q-02']);
    const pass = await g.gate('Q-02', { bundleCode: g.codes[0], action: 'qc_pass' }).expect(200);
    expect(pass.body).toMatchObject({ ok: false, status: 'active', nextOp: 'sew_collar', round: 0 });
    const own = await prisma.bundle.findUniqueOrThrow({ where: { code: g.codes[0] } });
    expect(await prisma.bundleEvent.count({ where: { bundleId: own.id, source: 'gate', gateId: { not: null } } })).toBe(
      0,
    );
  });

  it('scraps from SUP with one audit row, and a later clear is refused', async () => {
    const g = await guest(['S-07', 'Q-01', 'SUP']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 10_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'stain' }).expect(200);

    const scrap = await g.gate('SUP', { bundleCode: code, action: 'scrap' }).expect(200);
    expect(scrap.body).toMatchObject({ ok: true, status: 'scrapped', nextOp: null, round: 0 });
    const audits = await prisma.auditLog.findMany({ where: { entity: `bundle:${code}` } });
    expect(audits.map((a) => [a.actor, a.role, a.action])).toEqual([[g.name, 'supervisor', 'scrap']]);
    expect(audits[0].after).toEqual({ status: 'scrapped', nextStep: 'sew_sleeve', round: 0 });

    const clear = await g.gate('SUP', { bundleCode: code, action: 'clear_rework', targetOp: 'sew_collar' }).expect(200);
    expect(clear.body).toMatchObject({ ok: false, status: 'scrapped' });
    expect(await prisma.auditLog.count({ where: { entity: `bundle:${code}` } })).toBe(1);
  });

  it('cuts a new sim bundle at C-01 and ships a packed one at X-01', async () => {
    const cutter = await simDevice('C-01', 'sim-cutter');
    const cut = await simGate(cutter, { action: 'cut' }).expect(200);
    expect(cut.body).toMatchObject({ ok: true, status: 'active', nextOp: 'sew_collar', round: 0 });
    const code = cut.body.message.match(/^cut (B-\d{4,})$/)[1];
    const bundle = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    expect(bundle).toMatchObject({ isSimulated: true, guestId: null, pieces: 20 });
    const event = await prisma.bundleEvent.findFirstOrThrow({ where: { bundleId: bundle.id } });
    expect(event).toMatchObject({ op: 'cut', source: 'gate', deviceId: cutter, isSimulated: true });
    expect(event.gateId).not.toBeNull();
    const posting = await prisma.posting.findFirstOrThrow({ where: { eventId: event.id } });
    expect(posting).toMatchObject({ kind: 'labour', amountMills: 200, isSimulated: true, guestId: null });

    // Two cuts share no bundle lock, so the gateId index alone keeps a resend
    // from cutting twice.
    const gateId = randomUUID();
    const [a, b] = await Promise.all([
      simGate(cutter, { gateId, action: 'cut' }).expect(200),
      simGate(cutter, { gateId, action: 'cut' }).expect(200),
    ]);
    expect(b.body).toEqual(a.body);
    expect(await prisma.bundleEvent.count({ where: { gateId } })).toBe(1);

    const shipper = await simDevice('X-01', 'sim-shipper');
    const packed = await simBundle('ship', 'packed');
    const ship = await simGate(shipper, { bundleCode: packed.code, action: 'ship' }).expect(200);
    expect(ship.body).toMatchObject({ ok: true, status: 'shipped', nextOp: null, message: `${packed.code} shipped` });
    const again = await simGate(shipper, { bundleCode: packed.code, action: 'ship' }).expect(200);
    expect(again.body.ok).toBe(false);
  });

  it('refuses a stranger and holds a device to 5 gate calls a second', async () => {
    const g = await guest(['Q-02']);
    const other = await guest(['Q-02']);
    const theirs = await g.gate('Q-02', { bundleCode: other.codes[0], action: 'qc_pass' }).expect(403);
    expect(theirs.body).toEqual({ error: 'not your bundle' });
    const spoof = await other.gate('Q-02', { deviceId: g.devices['Q-02'], bundleCode: g.codes[0], action: 'qc_pass' });
    expect(spoof.status).toBe(403);
    expect(spoof.body).toEqual({ error: 'not your device' });

    clock.advance(1000);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await g.gate('Q-02', { bundleCode: g.codes[0], action: 'qc_pass' })).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    await g.gate('Q-02', { bundleCode: g.codes[0], action: 'qc_flag', defect: 'collar' }).expect(429);
    clock.advance(1000);
    await g.gate('Q-02', { gateId: 'not-a-uuid', bundleCode: g.codes[0], action: 'qc_pass' }).expect(400);
    await g.gate('Q-02', { bundleCode: g.codes[0], action: 'qc_fail' }).expect(400);
  });
});
