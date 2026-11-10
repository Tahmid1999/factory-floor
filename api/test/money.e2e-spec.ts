import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { POLO_ROUTE } from '../src/line/line';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

describe('trims, revenue and write-off', () => {
  let api: INestApplication;
  let worker: INestApplicationContext;
  let prisma: PrismaClient;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const now = () => clock.now().getTime();
  const sim = (path: string) => request(api.getHttpServer()).post(path).set('x-sim-key', process.env.SIM_KEY!);
  const simDevice = async (station: string, simName: string) =>
    (await sim('/devices').send({ station, simName }).expect(201)).body.deviceId as string;
  const simGate = (deviceId: string, body: object) =>
    sim('/gate/scan').send({ deviceId, gateId: randomUUID(), ...body });

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
    worker = await bootWorker(clock);
    worker.get(SchedulerRegistry).deleteInterval('sweep');
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await worker.close();
    await api.close();
  });

  const postingsOf = async (code: string) =>
    (await prisma.posting.findMany({ where: { bundleCode: code }, orderBy: { id: 'asc' } })).map((p) => ({
      kind: p.kind,
      amountMills: p.amountMills,
    }));
  const sum = (rows: { kind: string; amountMills: number }[], ...kinds: string[]) =>
    rows.filter((r) => kinds.includes(r.kind)).reduce((n, r) => n + r.amountMills, 0);
  const appliedCount = (code: string, op: string) =>
    prisma.scanInbox.count({ where: { bundleCode: code, op, result: 'applied' } });

  it('walks one bundle through the route and leaves 21,270 once every cost is taken off revenue', async () => {
    const cutter = await simDevice('C-01', 'sim-cutter');
    const cut = await simGate(cutter, { action: 'cut' }).expect(200);
    const code = (cut.body.message as string).replace('cut ', '');

    const stations: [string, string][] = [
      ['S-07', 'sew_collar'],
      ['S-08', 'sew_sleeve'],
      ['S-09', 'side_seam'],
      ['S-10', 'hem'],
    ];
    // Scans are refused from before the device registered.
    const devs = new Map<string, string>();
    for (const [station] of stations) devs.set(station, await simDevice(station, `sim-${station}`));
    const qc = await simDevice('Q-02', 'sim-qc');
    const packer = await simDevice('P-01', 'sim-packer');
    const shipper = await simDevice('X-01', 'sim-shipper');
    clock.advance(60_000);
    let ago = 9000;
    for (const [station, op] of stations) {
      const dev = devs.get(station)!;
      const events = [{ seq: 1, bundleCode: code, op, scannedAt: now() - ago, offsetMs: 0 }];
      await sim('/scans/batch').send({ deviceId: dev, deviceNow: now(), events }).expect(201);
      ago -= 1000;
      await until(async () => (await appliedCount(code, op)) > 0);
    }
    await simGate(qc, { bundleCode: code, action: 'qc_pass' }).expect(200);
    const pack = [{ seq: 1, bundleCode: code, op: 'pack', scannedAt: now() - 500, offsetMs: 0 }];
    await sim('/scans/batch').send({ deviceId: packer, deviceNow: now(), events: pack }).expect(201);
    await until(async () => (await appliedCount(code, 'pack')) > 0);
    await simGate(shipper, { bundleCode: code, action: 'ship' }).expect(200);

    const rows = await postingsOf(code);
    const labour = rows.filter((r) => r.kind === 'labour').map((r) => r.amountMills);
    expect(labour.sort((a, b) => a - b)).toEqual([120, 160, 200, 220, 240, 300]);
    expect(rows.filter((r) => r.kind === 'fabric')).toEqual([{ kind: 'fabric', amountMills: 61_200 }]);
    expect(rows.filter((r) => r.kind === 'trims')).toEqual([{ kind: 'trims', amountMills: 290 }]);
    expect(rows.filter((r) => r.kind === 'revenue')).toEqual([{ kind: 'revenue', amountMills: 84_000 }]);
    expect(rows).toHaveLength(9);
    expect(sum(rows, 'revenue') - sum(rows, 'fabric', 'labour', 'trims')).toBe(21_270);
  });

  // Walks a visitor's bundle: collar, sleeve, flag, clear back to the sleeve,
  // sleeve again.
  async function redoSleeve() {
    const g = await makeGuest(api, clock, ['S-07', 'S-08', 'Q-01', 'SUP']);
    const code = g.codes[0];
    await g.batch('S-07', [g.ev(1, code, 'sew_collar', 10_000)]).expect(201);
    await until(async () => (await appliedCount(code, 'sew_collar')) > 0);
    await g.batch('S-08', [g.ev(1, code, 'sew_sleeve', 8000)]).expect(201);
    await until(async () => (await appliedCount(code, 'sew_sleeve')) > 0);
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'sleeve' }).expect(200);
    clock.advance(1000);
    await g.gate('SUP', { bundleCode: code, action: 'clear_rework', targetOp: 'sew_sleeve' }).expect(200);
    clock.advance(1000);
    await g.batch('S-08', [g.ev(2, code, 'sew_sleeve', 0)]).expect(201);
    await until(async () => (await appliedCount(code, 'sew_sleeve')) > 1);
    return { g, code };
  }

  it('posts trims again for a redone sleeve and no second labour', async () => {
    const { code } = await redoSleeve();
    const rows = await postingsOf(code);
    expect(rows.filter((r) => r.kind === 'trims')).toEqual([
      { kind: 'trims', amountMills: 290 },
      { kind: 'trims', amountMills: 290 },
    ]);
    const labour = rows.filter((r) => r.kind === 'labour').map((r) => r.amountMills);
    expect(labour.sort((a, b) => a - b)).toEqual([200, 240, 300]);
  });

  it("writes off a visitor's bundle once, from its postings so far, and a repeat posts nothing", async () => {
    const { g, code } = await redoSleeve();
    await g.gate('Q-01', { bundleCode: code, action: 'qc_flag', defect: 'sleeve' }).expect(200);

    const before = await postingsOf(code);
    const costs = sum(before, 'fabric', 'labour', 'trims');
    expect(costs).toBe(61_200 + 200 + 300 + 240 + 290 + 290);

    const gateId = randomUUID();
    clock.advance(1000);
    await g.gate('SUP', { bundleCode: code, action: 'scrap', gateId }).expect(200);
    const off = await prisma.posting.findMany({ where: { bundleCode: code, kind: 'writeoff' } });
    expect(off).toHaveLength(1);
    expect(off[0]).toMatchObject({ amountMills: costs, isSimulated: false });
    expect(off[0].eventId).not.toBeNull();
    expect(off[0].guestId).not.toBeNull();

    await g.gate('SUP', { bundleCode: code, action: 'scrap', gateId }).expect(200);
    expect(await prisma.posting.count({ where: { bundleCode: code, kind: 'writeoff' } })).toBe(1);
    expect((await postingsOf(code)).length).toBe(before.length + 1);
  });

  it('refuses to scrap a shipped bundle and posts no write-off', async () => {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const b = await prisma.bundle.create({
      data: { code: 'B-7900', styleId: style.id, pieces: 20, status: 'shipped', nextStep: POLO_ROUTE.length, isSimulated: true },
    });
    const sup = await simDevice('SUP', 'sim-sup');
    const r = await simGate(sup, { bundleCode: b.code, action: 'scrap' }).expect(200);
    expect(r.body).toMatchObject({ ok: false, status: 'shipped' });
    expect(await prisma.posting.count({ where: { bundleCode: b.code, kind: 'writeoff' } })).toBe(0);
  });
});
