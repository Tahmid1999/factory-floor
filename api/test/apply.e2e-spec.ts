import { INestApplication, INestApplicationContext, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { APPLY_HOOKS, ApplyHooks, ApplyService } from '../src/apply/apply.service';
import { SweepService } from '../src/apply/sweep.service';
import { FixedClock } from '../src/clock';
import type { HoodEvent } from '../src/hood/hood-event';
import { POLO_ROUTE } from '../src/line/line';
import { Rabbit } from '../src/rabbit';
import { bootApi, bootWorker, purgeQueues, resetDb } from './helpers';

let nextIp = 10;
const freshIp = () => `203.0.113.${nextIp++}`;

async function until<T>(check: () => Promise<T | undefined | false>, ms = 20000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting for the worker');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('apply worker', () => {
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
    // The real 30 s timer would fire mid-suite against the fixed clock; the
    // sweep test drives runOnce by hand instead.
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
    jest.restoreAllMocks();
    hooks.beforeCommit = () => undefined;
  });

  // One guest with a device per station asked for, and the guest's 3 bundles.
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
    const meNow = () => agent.get('/me').set('x-forwarded-for', ip).expect(200);
    return { devices, codes, send, meNow };
  }

  const ev = (seq: number, bundleCode: string, op: string, agoMs: number) => ({
    seq,
    bundleCode,
    op,
    scannedAt: now() - agoMs,
    offsetMs: 0,
  });

  const inboxOf = (deviceId: string, seq: number) =>
    prisma.scanInbox.findUniqueOrThrow({ where: { deviceId_seq: { deviceId, seq } } });

  const resultOf = async (deviceId: string, seq: number, want: string) => {
    const row = await inboxOf(deviceId, seq);
    return row.result === want ? row : undefined;
  };

  it('applies 50 shuffled events from 5 devices on one bundle, once per op, and ends at qc_final', async () => {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const bundle = await prisma.bundle.create({
      data: {
        code: 'B-7001',
        styleId: style.id,
        pieces: 20,
        status: 'active',
        nextStep: POLO_ROUTE.indexOf('sew_collar'),
        isSimulated: true,
      },
    });
    const sim = (path: string) => request(api.getHttpServer()).post(path).set('x-sim-key', process.env.SIM_KEY!);
    // Two sleeve sewers share the busiest step.
    const crew = [
      { station: 'S-07', simName: 'shuffle-a', op: 'sew_collar' },
      { station: 'S-08', simName: 'shuffle-a', op: 'sew_sleeve' },
      { station: 'S-08', simName: 'shuffle-b', op: 'sew_sleeve' },
      { station: 'S-09', simName: 'shuffle-a', op: 'side_seam' },
      { station: 'S-10', simName: 'shuffle-a', op: 'hem' },
    ];
    const ids: string[] = [];
    for (const c of crew) {
      ids.push((await sim('/devices').send({ station: c.station, simName: c.simName }).expect(201)).body.deviceId);
    }
    clock.advance(60_000);

    // Each device double-taps its step ten times; the corrected times are
    // spread so a sleeve tap can sort before the collar ever arrives.
    const batches: { deviceId: string; events: object[] }[] = [];
    crew.forEach((c, d) => {
      const events = Array.from({ length: 10 }, (_, i) =>
        ev(i + 1, bundle.code, c.op, 1000 + ((d * 7 + i * 13) % 50) * 500),
      );
      shuffle(events);
      batches.push({ deviceId: ids[d], events: events.slice(0, 5) }, { deviceId: ids[d], events: events.slice(5) });
    });
    shuffle(batches);
    await Promise.all(
      batches.map((b) =>
        sim('/scans/batch').send({ deviceId: b.deviceId, deviceNow: now(), events: b.events }).expect(201),
      ),
    );

    await until(async () => {
      const open = await prisma.scanInbox.count({
        where: { deviceId: { in: ids }, OR: [{ result: null }, { result: 'held' }] },
      });
      return open === 0;
    });

    const after = await prisma.bundle.findUniqueOrThrow({ where: { id: bundle.id } });
    expect(after.status).toBe('active');
    expect(POLO_ROUTE[after.nextStep]).toBe('qc_final');
    const events = await prisma.bundleEvent.findMany({ where: { bundleId: bundle.id } });
    expect(events.map((e) => e.op).sort()).toEqual(['hem', 'sew_collar', 'sew_sleeve', 'side_seam']);
    expect(events.every((e) => e.isSimulated && !e.wasted && e.round === 0)).toBe(true);
    const postings = await prisma.posting.findMany({ where: { bundleCode: bundle.code, kind: 'labour' } });
    const byOp = new Map(events.map((e) => [e.id, e.op]));
    expect(postings.map((p) => [byOp.get(p.eventId!), p.amountMills]).sort()).toEqual([
      ['hem', 160],
      ['sew_collar', 300],
      ['sew_sleeve', 240],
      ['side_seam', 220],
    ]);
    expect(postings.every((p) => p.isSimulated && p.period === '2026-11' && p.guestId === null)).toBe(true);
    const results = await prisma.scanInbox.groupBy({
      by: ['result'],
      where: { deviceId: { in: ids } },
      _count: true,
    });
    expect(Object.fromEntries(results.map((r) => [r.result, r._count]))).toEqual({ applied: 4, duplicate: 46 });
    expect(await prisma.heldEvent.count({ where: { bundleId: bundle.id } })).toBe(0);
  });

  it('holds sew_sleeve that arrives before sew_collar, then applies it right after', async () => {
    const g = await guest(['S-07', 'S-08']);
    const code = g.codes[0];
    await g.send('S-08', [ev(1, code, 'sew_sleeve', 5000)]);
    await until(() => resultOf(g.devices['S-08'], 1, 'held'));
    const sleeve = await inboxOf(g.devices['S-08'], 1);
    expect(await prisma.heldEvent.count({ where: { inboxId: sleeve.id } })).toBe(1);

    await g.send('S-07', [ev(1, code, 'sew_collar', 10_000)]);
    await until(() => resultOf(g.devices['S-08'], 1, 'applied'));

    const b = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    expect(POLO_ROUTE[b.nextStep]).toBe('side_seam');
    expect(await prisma.heldEvent.count({ where: { inboxId: sleeve.id } })).toBe(0);
    await until(async () => hood.filter((h) => h.text.includes(code)).length >= 3, 2000);
    const texts = hood.filter((h) => h.text.includes(code)).map((h) => h.text.replace(/ · lock.*/, ''));
    expect(texts).toEqual([`held ${code} sew_sleeve`, `apply ${code} sew_collar`, `released ${code} sew_sleeve`]);
    const applied = hood.find((h) => h.text.startsWith(`apply ${code} sew_collar`))!;
    expect(applied.proc).toBe('worker');
    expect(applied.text).toMatch(/^apply B-\d+ sew_collar · lock \d+ ms · tx \d+ ms$/);
    const postings = await prisma.posting.findMany({ where: { bundleCode: code, kind: 'labour' } });
    expect(postings.map((p) => p.amountMills).sort((a, b) => a - b)).toEqual([200, 240, 300]);
    // The visitor sewed collar and sleeve; only the cut was the sim's.
    const sewn = postings.filter((p) => p.amountMills !== 200);
    expect(sewn.every((p) => !p.isSimulated)).toBe(true);
  });

  it('applies an inbox id published three times exactly once', async () => {
    const g = await guest(['S-07']);
    const spy = jest.spyOn(worker.get(ApplyService), 'apply');
    await g.send('S-07', [ev(1, g.codes[0], 'sew_collar', 1000)]);
    const row = await inboxOf(g.devices['S-07'], 1);
    const rabbit = api.get(Rabbit);
    await Promise.all([rabbit.publishApply(row.id), rabbit.publishApply(row.id)]);

    await until(async () => spy.mock.calls.filter((c) => c[0] === row.id).length === 3);
    const outcomes = await Promise.all(spy.mock.results.map((r) => r.value));
    expect(outcomes.sort()).toEqual(['applied', 'skipped', 'skipped']);
    expect(await prisma.bundleEvent.count({ where: { inboxId: row.id } })).toBe(1);
    const event = await prisma.bundleEvent.findUniqueOrThrow({ where: { inboxId: row.id } });
    expect(await prisma.posting.count({ where: { eventId: event.id } })).toBe(1);
  });

  it('wastes the sleeve applied after an earlier qc_flag: 530 mills, S-08 told', async () => {
    const g = await guest(['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 30_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    await g.send('S-08', [ev(4, code, 'sew_sleeve', 10_000)]);
    await until(() => resultOf(g.devices['S-08'], 4, 'applied'));

    // The flag was raised before the sleeve was sewn, but its batch landed later.
    await g.send('Q-01', [ev(1, code, 'qc_flag', 20_000)]);
    await until(() => resultOf(g.devices['Q-01'], 1, 'applied'));

    const b = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    expect(b.status).toBe('rework');
    expect(POLO_ROUTE[b.nextStep]).toBe('side_seam');
    const events = await prisma.bundleEvent.findMany({ where: { bundleId: b.id }, orderBy: { correctedAt: 'asc' } });
    expect(events.map((e) => [e.op, e.wasted])).toEqual([
      ['cut', false],
      ['sew_collar', false],
      ['qc_flag', false],
      ['sew_sleeve', true],
    ]);
    const me = await g.meNow();
    expect(me.body.bundles.find((x: { code: string }) => x.code === code).wastedMills).toBe(530);

    const notices = await prisma.deviceNotice.findMany({ where: { bundleCode: code } });
    expect(notices.map((n) => [n.deviceId, n.seq, n.result])).toEqual([[g.devices['S-08'], 4, 'wasted']]);
    clock.advance(1000);
    const sync = await g.send('S-08', []);
    expect(sync.body.notices).toEqual([{ id: notices[0].id, seq: 4, bundleCode: code, result: 'wasted' }]);
    await until(async () => hood.some((h) => h.text === `rework ${code} qc_flag · wasted 530 mills`), 2000);
  });

  it('prices a wasted redo by what was posted: an unpaid sleeve redo wastes its trims only', async () => {
    const g = await guest(['S-07', 'S-08', 'Q-01']);
    const code = g.codes[0];
    await g.send('S-07', [ev(1, code, 'sew_collar', 50_000)]);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    await g.send('S-08', [ev(1, code, 'sew_sleeve', 40_000)]);
    await until(() => resultOf(g.devices['S-08'], 1, 'applied'));

    // What a supervisor clear back to sew_sleeve leaves behind; the gate that
    // does it for real is tested in the gate suite.
    await prisma.bundle.update({
      where: { code },
      data: { reworkRound: 1, nextStep: POLO_ROUTE.indexOf('sew_sleeve'), lastClearedAt: new Date(now() - 30_000) },
    });
    await g.send('S-08', [ev(2, code, 'sew_sleeve', 10_000)]);
    const redo = await until(() => resultOf(g.devices['S-08'], 2, 'applied'));
    const redoEvent = await prisma.bundleEvent.findUniqueOrThrow({ where: { inboxId: redo.id } });
    // Unpaid labour, but the trims were used again.
    expect(await prisma.posting.count({ where: { eventId: redoEvent.id, kind: 'labour' } })).toBe(0);
    expect(await prisma.posting.count({ where: { eventId: redoEvent.id, kind: 'trims' } })).toBe(1);

    await g.send('Q-01', [ev(1, code, 'qc_flag', 20_000)]);
    await until(() => resultOf(g.devices['Q-01'], 1, 'applied'));
    expect((await prisma.bundleEvent.findUniqueOrThrow({ where: { id: redoEvent.id } })).wasted).toBe(true);
    const me = await g.meNow();
    expect(me.body.bundles.find((x: { code: string }) => x.code === code).wastedMills).toBe(290);
    await until(async () => hood.some((h) => h.text === `rework ${code} qc_flag · wasted 290 mills`), 2000);
  });

  it('rejects a qc_flag on a bundle not yet past sew_collar, with a notice', async () => {
    const g = await guest(['Q-01']);
    const code = g.codes[0];
    await g.send('Q-01', [ev(3, code, 'qc_flag', 1000)]);
    await until(() => resultOf(g.devices['Q-01'], 3, 'rejected(cannot-flag)'));
    const b = await prisma.bundle.findUniqueOrThrow({ where: { code } });
    expect(b.status).toBe('active');
    const notices = await prisma.deviceNotice.findMany({ where: { deviceId: g.devices['Q-01'] } });
    expect(notices.map((n) => [n.seq, n.bundleCode, n.result])).toEqual([[3, code, 'rejected(cannot-flag)']]);
  });

  it('rejects a scan made before the last rework clear as stale-round', async () => {
    const g = await guest(['S-07']);
    const code = g.codes[0];
    await prisma.bundle.update({ where: { code }, data: { lastClearedAt: new Date(now() - 5000) } });
    await g.send('S-07', [ev(1, code, 'sew_collar', 8000), ev(2, code, 'sew_collar', 2000)]);
    // The two rows apply in parallel under prefetch, so seq 2 can land first.
    await until(() => resultOf(g.devices['S-07'], 2, 'applied'));
    await until(() => resultOf(g.devices['S-07'], 1, 'rejected(stale-round)'));
    const notices = await prisma.deviceNotice.findMany({ where: { deviceId: g.devices['S-07'] } });
    expect(notices.map((n) => [n.seq, n.result])).toEqual([[1, 'rejected(stale-round)']]);
    expect(await prisma.bundleEvent.count({ where: { inboxId: (await inboxOf(g.devices['S-07'], 1)).id } })).toBe(0);
  });

  it('republishes an inbox row whose publish failed once it is 30 s old, and applies it once', async () => {
    const g = await guest(['S-07']);
    jest.spyOn(api.get(Rabbit), 'publishApply').mockRejectedValueOnce(new Error('broker down'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await g.send('S-07', [ev(1, g.codes[0], 'sew_collar', 1000)]);
    const row = await inboxOf(g.devices['S-07'], 1);
    expect(row.result).toBeNull();

    const sweep = worker.get(SweepService);
    clock.advance(29_000);
    expect(await sweep.runOnce()).toBe(0);
    clock.advance(2000);
    expect(await sweep.runOnce()).toBe(1);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    expect(await sweep.runOnce()).toBe(0);
    expect(await prisma.bundleEvent.count({ where: { inboxId: row.id } })).toBe(1);
    await until(async () => hood.some((h) => h.text === 'sweep republished 1' && h.proc === 'worker'), 2000);
  });

  // A worker that dies holds the message unacked; the broker gives it out
  // again when the connection goes, with nothing of the first try committed.
  it('writes nothing when the worker dies after the lock, then applies the redelivery once', async () => {
    const g = await guest(['S-07']);
    const rabbit = worker.get(Rabbit);
    const spy = jest.spyOn(worker.get(ApplyService), 'apply');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let calls = 0;
    let release!: () => void;
    const hung = new Promise<void>((r) => (release = r));
    hooks.beforeCommit = async () => {
      calls++;
      if (calls > 1) return;
      // The event, posting and result are written by now but not committed.
      // The connection goes while this transaction is still open.
      await (rabbit as any).conn.close();
      await hung;
      throw new Error('worker died');
    };
    await g.send('S-07', [ev(1, g.codes[0], 'sew_collar', 1000)]);
    const row = await inboxOf(g.devices['S-07'], 1);
    // The redelivery waits on the bundle lock the dying try still holds.
    await until(async () => spy.mock.calls.length === 2);
    release();
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));

    expect(calls).toBe(2);
    expect(await prisma.bundleEvent.count({ where: { inboxId: row.id } })).toBe(1);
    const event = await prisma.bundleEvent.findUniqueOrThrow({ where: { inboxId: row.id } });
    expect(await prisma.posting.count({ where: { eventId: event.id } })).toBe(1);
    const b = await prisma.bundle.findUniqueOrThrow({ where: { code: g.codes[0] } });
    expect(POLO_ROUTE[b.nextStep]).toBe('sew_sleeve');
  });

  // An apply that throws is nacked without a requeue, so a poison message
  // does not spin the worker; the sweep is its retry.
  it('drops a message whose apply throws, writes nothing, and the sweep applies it once', async () => {
    const g = await guest(['S-07']);
    const spy = jest.spyOn(worker.get(ApplyService), 'apply');
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let calls = 0;
    hooks.beforeCommit = async () => {
      calls++;
      if (calls === 1) throw new Error('apply failed');
    };
    await g.send('S-07', [ev(1, g.codes[0], 'sew_collar', 1000)]);
    const row = await inboxOf(g.devices['S-07'], 1);
    await until(async () => spy.mock.results.length === 1);
    await expect(spy.mock.results[0].value).rejects.toThrow('apply failed');

    // A requeue would be back within milliseconds.
    await new Promise((r) => setTimeout(r, 1000));
    expect(calls).toBe(1);
    expect((await inboxOf(g.devices['S-07'], 1)).result).toBeNull();
    expect(await prisma.bundleEvent.count({ where: { inboxId: row.id } })).toBe(0);

    clock.advance(31_000);
    expect(await worker.get(SweepService).runOnce()).toBe(1);
    await until(() => resultOf(g.devices['S-07'], 1, 'applied'));
    expect(calls).toBe(2);
    expect(await prisma.bundleEvent.count({ where: { inboxId: row.id } })).toBe(1);
    const event = await prisma.bundleEvent.findUniqueOrThrow({ where: { inboxId: row.id } });
    expect(await prisma.posting.count({ where: { eventId: event.id } })).toBe(1);
  });

  it('settles a scan whose bundle is gone as rejected(gone), so the sweep stops sending it', async () => {
    const g = await guest(['S-07']);
    jest.spyOn(api.get(Rabbit), 'publishApply').mockRejectedValueOnce(new Error('broker down'));
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await g.send('S-07', [ev(1, g.codes[0], 'sew_collar', 1000)]);
    // The bundle goes before the row is applied, as a reset would take it.
    await prisma.bundle.delete({ where: { code: g.codes[0] } });

    clock.advance(31_000);
    const sweep = worker.get(SweepService);
    expect(await sweep.runOnce()).toBe(1);
    await until(() => resultOf(g.devices['S-07'], 1, 'rejected(gone)'));
    clock.advance(31_000);
    expect(await sweep.runOnce()).toBe(0);
  });
});

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
