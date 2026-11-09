import { INestApplication, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { IngestService } from '../src/ingest/ingest.service';
import { Rabbit } from '../src/rabbit';
import { bootApi, purgeQueues, resetDb } from './helpers';

// Limits are in memory and not reset between tests, so every test uses its own
// network address and its own device.
let nextIp = 10;
const freshIp = () => `198.51.100.${nextIp++}`;

const HOUR = 3_600_000;

describe('batch ingest', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const now = () => clock.now().getTime();

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    app = await bootApi(clock);
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  // A guest with a cookie, one device and the guest's 3 bundles.
  async function station(code = 'S-07') {
    const agent = request.agent(app.getHttpServer());
    const ip = freshIp();
    const me = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    const dev = await agent.post('/devices').set('x-forwarded-for', ip).send({ station: code }).expect(201);
    const codes: string[] = me.body.bundles.map((b: { code: string }) => b.code);
    // Scans must not predate the device, so time moves on after registering.
    clock.advance(60_000);
    const send = (body: object) => agent.post('/scans/batch').set('x-forwarded-for', ip).send(body);
    return { agent, ip, deviceId: dev.body.deviceId as string, codes, send };
  }

  const ev = (seq: number, bundleCode: string, over: Record<string, unknown> = {}) => ({
    seq,
    bundleCode,
    op: 'sew_collar',
    scannedAt: now() - 1000,
    offsetMs: 0,
    ...over,
  });

  it('accepts a batch, then answers duplicate for the same batch, with one inbox row each', async () => {
    const s = await station();
    const body = { deviceId: s.deviceId, deviceNow: now(), events: [ev(1, s.codes[0]), ev(2, s.codes[1])] };
    const first = await s.send(body).expect(201);
    expect(first.body.serverNow).toBe(now());
    expect(first.body.results).toEqual([
      { seq: 1, result: 'accepted' },
      { seq: 2, result: 'accepted' },
    ]);
    clock.advance(1000);
    const second = await s.send(body).expect(201);
    expect(second.body.results).toEqual([
      { seq: 1, result: 'duplicate' },
      { seq: 2, result: 'duplicate' },
    ]);
    expect(await prisma.scanInbox.count({ where: { deviceId: s.deviceId } })).toBe(2);
  });

  it('five parallel sends of the same batch give exactly one accepted per seq', async () => {
    const s = await station();
    const ingest = app.get(IngestService);
    const events = [1, 2, 3].map((n) => ev(n, s.codes[n - 1]));
    const dev = await prisma.device.findUniqueOrThrow({ where: { id: s.deviceId } });
    const actor = { guestId: dev.guestId!, sim: false };
    // Straight to the service: the 2 per second limit sits in the controller,
    // and a flaky network can still deliver more than that at once.
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => ingest.ingest(actor, dev, { deviceId: s.deviceId, deviceNow: now(), events })),
    );
    for (const seq of [1, 2, 3]) {
      const verdicts = replies.map((r) => r.results.find((x) => x.seq === seq)!.result);
      expect(verdicts.filter((v) => v === 'accepted')).toHaveLength(1);
      expect(verdicts.filter((v) => v === 'duplicate')).toHaveLength(4);
    }
    expect(await prisma.scanInbox.count({ where: { deviceId: s.deviceId } })).toBe(3);
  });

  it('rejects an event 25 h old as clock and writes no row', async () => {
    const s = await station();
    const res = await s.send({
      deviceId: s.deviceId,
      deviceNow: now(),
      events: [ev(1, s.codes[0], { scannedAt: now() - 25 * HOUR })],
    });
    expect(res.body.results).toEqual([{ seq: 1, result: 'rejected', reason: 'clock' }]);
    expect(await prisma.scanInbox.count({ where: { deviceId: s.deviceId } })).toBe(0);
  });

  it('rejects an event from before the device registered, and one from the future', async () => {
    const s = await station();
    clock.advance(2 * HOUR);
    const res = await s.send({
      deviceId: s.deviceId,
      deviceNow: now(),
      events: [
        ev(1, s.codes[0], { scannedAt: now() - 3 * HOUR }),
        ev(2, s.codes[0], { scannedAt: now() + 2 * 60_000 }),
        ev(3, s.codes[0], { scannedAt: now() + 30_000 }),
      ],
    });
    expect(res.body.results.map((r: { reason?: string; result: string }) => r.reason ?? r.result)).toEqual([
      'clock',
      'clock',
      'accepted',
    ]);
  });

  it('accepts a scan from a device clock 2 h ahead when offsetMs corrects it', async () => {
    const s = await station();
    const scannedAt = now() + 2 * HOUR - 5000;
    const res = await s.send({
      deviceId: s.deviceId,
      deviceNow: now() + 2 * HOUR,
      events: [ev(1, s.codes[0], { scannedAt, offsetMs: -2 * HOUR })],
    });
    expect(res.body.results).toEqual([{ seq: 1, result: 'accepted' }]);
    const row = await prisma.scanInbox.findFirstOrThrow({ where: { deviceId: s.deviceId } });
    expect(row.correctedAt.getTime()).toBe(now() - 5000);
    expect(row.scannedAt.getTime()).toBe(scannedAt);
    const dev = await prisma.device.findUniqueOrThrow({ where: { id: s.deviceId } });
    expect(dev.clockOffsetMs).toBe(-2 * HOUR);
    expect(dev.lastSyncAt?.getTime()).toBe(now());
    expect(dev.lastPending).toBe(1);
  });

  it('rejects an event for a bundle in rework and resyncs that bundle once', async () => {
    const s = await station();
    await prisma.bundle.update({ where: { code: s.codes[0] }, data: { status: 'rework', reworkRound: 1 } });
    const res = await s.send({
      deviceId: s.deviceId,
      deviceNow: now(),
      events: [ev(1, s.codes[0]), ev(2, s.codes[0], { op: 'sew_sleeve' }), ev(3, s.codes[1])],
    });
    expect(res.body.results).toEqual([
      { seq: 1, result: 'rejected', reason: 'rework' },
      { seq: 2, result: 'rejected', reason: 'rework' },
      { seq: 3, result: 'accepted' },
    ]);
    expect(res.body.resync).toEqual([{ bundleCode: s.codes[0], status: 'rework', nextOp: 'sew_collar', round: 1 }]);
    const rows = await prisma.scanInbox.findMany({ where: { deviceId: s.deviceId }, orderBy: { seq: 'asc' } });
    expect(rows.map((r) => r.result)).toEqual(['rejected(rework)', 'rejected(rework)', null]);
  });

  it('rejects not-yours, unknown codes and gate-only ops without a row', async () => {
    const s = await station();
    const other = await station();
    const res = await s.send({
      deviceId: s.deviceId,
      deviceNow: now(),
      events: [
        ev(1, other.codes[0]),
        ev(2, 'B-0000'),
        ev(3, s.codes[0], { op: 'ship' }),
        ev(4, s.codes[0], { op: 'cut' }),
        ev(5, s.codes[0], { op: 'qc_final' }),
        ev(6, s.codes[0], { op: 'qc_flag' }),
      ],
    });
    expect(res.body.results).toEqual([
      { seq: 1, result: 'rejected', reason: 'not-yours' },
      { seq: 2, result: 'rejected', reason: 'not-yours' },
      { seq: 3, result: 'rejected', reason: 'gate-only' },
      { seq: 4, result: 'rejected', reason: 'gate-only' },
      { seq: 5, result: 'rejected', reason: 'gate-only' },
      { seq: 6, result: 'accepted' },
    ]);
    const seqs = (await prisma.scanInbox.findMany({ where: { deviceId: s.deviceId } })).map((r) => r.seq);
    expect(seqs).toEqual([6]);
  });

  it('delivers a notice once and not on the next heartbeat, and resyncs its bundle', async () => {
    const s = await station();
    await prisma.deviceNotice.create({
      data: { deviceId: s.deviceId, seq: 7, bundleCode: s.codes[2], result: 'rework' },
    });
    const hb = { deviceId: s.deviceId, deviceNow: now(), events: [] };
    const first = await s.send(hb).expect(201);
    expect(first.body.notices).toEqual([{ seq: 7, bundleCode: s.codes[2], result: 'rework' }]);
    expect(first.body.resync).toEqual([{ bundleCode: s.codes[2], status: 'active', nextOp: 'sew_collar', round: 0 }]);
    expect(first.body.results).toEqual([]);
    clock.advance(1000);
    const second = await s.send(hb).expect(201);
    expect(second.body.notices).toEqual([]);
    expect(second.body.resync).toEqual([]);
    const notice = await prisma.deviceNotice.findFirstOrThrow({ where: { deviceId: s.deviceId } });
    expect(notice.deliveredAt).not.toBeNull();
  });

  it('still answers accepted and leaves result null when the publish fails', async () => {
    const s = await station();
    jest.spyOn(app.get(Rabbit), 'publishApply').mockRejectedValue(new Error('broker down'));
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const res = await s.send({ deviceId: s.deviceId, deviceNow: now(), events: [ev(1, s.codes[0])] }).expect(201);
    expect(res.body.results).toEqual([{ seq: 1, result: 'accepted' }]);
    const row = await prisma.scanInbox.findFirstOrThrow({ where: { deviceId: s.deviceId } });
    expect(row.result).toBeNull();
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('publishes each accepted id after commit', async () => {
    const s = await station();
    const pub = jest.spyOn(app.get(Rabbit), 'publishApply').mockResolvedValue(undefined);
    await s.send({ deviceId: s.deviceId, deviceNow: now(), events: [ev(1, s.codes[0]), ev(2, s.codes[1])] });
    const rows = await prisma.scanInbox.findMany({ where: { deviceId: s.deviceId }, orderBy: { seq: 'asc' } });
    expect(pub.mock.calls.map((c) => c[0])).toEqual(rows.map((r) => r.id));
  });

  it("refuses a device that is not the caller's with 403", async () => {
    const s = await station();
    const other = await station();
    const res = await other.send({ deviceId: s.deviceId, deviceNow: now(), events: [] }).expect(403);
    expect(res.body).toEqual({ error: 'not your device' });
    await other.send({ deviceId: 'nope', deviceNow: now(), events: [] }).expect(403);
  });

  it('lets the sim batch for its own devices and not for a guest device', async () => {
    const s = await station();
    const dev = await request(app.getHttpServer())
      .post('/devices')
      .set('x-sim-key', process.env.SIM_KEY!)
      .send({ station: 'S-08', simName: 'sim-sewer-ingest' })
      .expect(201);
    const sim = (body: object) =>
      request(app.getHttpServer()).post('/scans/batch').set('x-sim-key', process.env.SIM_KEY!).send(body);
    await sim({ deviceId: s.deviceId, deviceNow: now(), events: [] }).expect(403);
    const res = await sim({ deviceId: dev.body.deviceId, deviceNow: now(), events: [] }).expect(201);
    expect(res.body.results).toEqual([]);
    // a sim device cannot touch a visitor's bundle
    clock.advance(1000);
    const bad = await sim({ deviceId: dev.body.deviceId, deviceNow: now(), events: [ev(1, s.codes[0])] }).expect(201);
    expect(bad.body.results).toEqual([{ seq: 1, result: 'rejected', reason: 'not-yours' }]);
  });

  it('limits a device to 2 batches per second with 429 and 50 events with 413', async () => {
    const s = await station();
    const hb = { deviceId: s.deviceId, deviceNow: now(), events: [] };
    await s.send(hb).expect(201);
    await s.send(hb).expect(201);
    await s.send(hb).expect(429);
    clock.advance(1000);
    await s.send(hb).expect(201);
    const events = Array.from({ length: 51 }, (_, i) => ev(i + 1, s.codes[0]));
    await s.send({ deviceId: s.deviceId, deviceNow: now(), events }).expect(413);
    expect(await prisma.scanInbox.count({ where: { deviceId: s.deviceId } })).toBe(0);
  });

  it('answers 400 for a malformed body', async () => {
    const s = await station();
    await s.send({ deviceId: s.deviceId, events: [] }).expect(400);
    await s.send({ deviceId: s.deviceId, deviceNow: now(), events: [{ seq: 'x' }] }).expect(400);
    await s.send({ deviceId: s.deviceId, deviceNow: now(), events: [ev(1, s.codes[0], { op: 'dance' })] }).expect(400);
  });
});
