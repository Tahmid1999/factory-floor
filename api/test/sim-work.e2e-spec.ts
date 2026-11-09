import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { bootApi, makeGuest, purgeQueues, resetDb } from './helpers';

describe('GET /sim/work', () => {
  let api: INestApplication;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
  const key = () => ({ 'x-sim-key': process.env.SIM_KEY! });
  const work = (station: string) => request(api.getHttpServer()).get('/sim/work').query({ station }).set(key());

  beforeAll(async () => {
    await resetDb();
    await purgeQueues();
    api = await bootApi(clock);
  });

  afterAll(async () => {
    await api.close();
  });

  it('answers 404 without the key, with a wrong key, or when the call came through the proxy', async () => {
    const plain = request(api.getHttpServer());
    await plain.get('/sim/work').query({ station: 'S-07' }).expect(404);
    await plain.get('/sim/work').query({ station: 'S-07' }).set('x-sim-key', 'nope').expect(404);
    await plain.get('/sim/work').query({ station: 'S-07' }).set(key()).set('x-forwarded-for', '198.51.100.9').expect(404);
  });

  it('rejects an unknown station', async () => {
    await work('Z-99').expect(400);
  });

  it('lists simulated bundles at their station, oldest first, and counts those at the collar', async () => {
    const cutter = await request(api.getHttpServer())
      .post('/devices')
      .set(key())
      .send({ station: 'C-01', simName: 'sim-cutter' })
      .expect(201);
    const cut: string[] = [];
    for (let i = 0; i < 3; i++) {
      clock.advance(1000);
      const r = await request(api.getHttpServer())
        .post('/gate/scan')
        .set(key())
        .send({ deviceId: cutter.body.deviceId, gateId: randomUUID(), action: 'cut' })
        .expect(200);
      cut.push(/B-\d+/.exec(r.body.message)![0]);
    }
    const s07 = await work('S-07').expect(200);
    expect(s07.body.bundles.map((b: { code: string }) => b.code)).toEqual(cut);
    expect((await work('C-01').expect(200)).body).toEqual({ waitingAtCollar: 3 });
    expect((await work('S-08').expect(200)).body.bundles).toEqual([]);
    expect((await work('Q-01').expect(200)).body.bundles).toEqual([]);
    expect((await work('SUP').expect(200)).body.bundles).toEqual([]);
  });

  it('leaves a visitor their bundles until they are quiet for 5 minutes', async () => {
    const guest = await makeGuest(api, clock, ['S-07']);
    const listed = async () => (await work('S-07').expect(200)).body.bundles.map((b: { code: string }) => b.code);
    expect(await listed()).not.toContain(guest.codes[0]);
    clock.advance(5 * 60_000);
    expect(await listed()).toEqual(expect.arrayContaining(guest.codes));
  });
});
