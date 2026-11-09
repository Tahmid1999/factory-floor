import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { FixedClock } from '../src/clock';
import { bootApi, resetDb } from './helpers';

// Supertest connects from loopback, so a client address is faked the way the
// production proxy reports it: through x-forwarded-for.
let nextIp = 10;
const freshIp = () => `198.51.100.${nextIp++}`;

describe('guests', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));

  beforeAll(async () => {
    await resetDb();
    app = await bootApi(clock);
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  it('sets the cookie on the first GET /me and lists 3 bundles at sew_collar', async () => {
    const ip = freshIp();
    const res = await http().get('/me').set('x-forwarded-for', ip).expect(200);
    expect(res.headers['set-cookie'][0]).toMatch(/ff_guest=.*HttpOnly.*SameSite=Lax/i);
    expect(res.body.name).toMatch(/^guest-\d{4}$/);
    expect(res.body.mode).toBe('hybrid');
    expect(res.body.serverNow).toBe(clock.now().getTime());
    expect(res.body.bundles).toHaveLength(3);
    for (const b of res.body.bundles) {
      expect(b.code).toMatch(/^B-\d{4}$/);
      expect(b).toMatchObject({ status: 'active', nextOp: 'sew_collar', round: 0, wastedMills: 0 });
    }
    const codes = res.body.bundles.map((b: { code: string }) => b.code);
    expect(new Set(codes).size).toBe(3);
  });

  it('numbers bundle codes from B-8492 and writes the cut event and labour posting', async () => {
    await resetDb();
    const res = await http().get('/me').set('x-forwarded-for', freshIp()).expect(200);
    expect(res.body.bundles.map((b: { code: string }) => b.code)).toEqual(['B-8492', 'B-8493', 'B-8494']);

    const bundle = await prisma.bundle.findUniqueOrThrow({ where: { code: 'B-8492' } });
    expect(bundle).toMatchObject({ nextStep: 1, pieces: 20, isSimulated: false });
    const ev = await prisma.bundleEvent.findFirstOrThrow({ where: { bundleId: bundle.id } });
    expect(ev).toMatchObject({ op: 'cut', source: 'gate', round: 0, isSimulated: true, wasted: false });
    expect(ev.correctedAt.toISOString()).toBe(clock.now().toISOString());
    const dev = await prisma.device.findUniqueOrThrow({ where: { id: ev.deviceId! } });
    expect(dev).toMatchObject({ code: 'C-01', simName: 'sim-cutter', isSimulated: true, guestId: null });
    const posting = await prisma.posting.findFirstOrThrow({ where: { bundleCode: 'B-8492' } });
    expect(posting).toMatchObject({
      kind: 'labour',
      amountMills: 200,
      period: '2026-11',
      // the sim cutter did the work, so "exclude simulated" leaves it out
      isSimulated: true,
      guestId: bundle.guestId,
      eventId: ev.id,
    });
    // the sim cutter is shared, not recreated per bundle
    expect(await prisma.device.count({ where: { simName: 'sim-cutter' } })).toBe(1);
  });

  it('reuses the guest on a later request with the cookie', async () => {
    const agent = request.agent(app.getHttpServer());
    const ip = freshIp();
    const a = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    const b = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    expect(b.body.name).toBe(a.body.name);
    expect(b.headers['set-cookie']).toBeUndefined();
  });

  it('creates a fresh guest when the cookie is tampered with', async () => {
    const res = await http()
      .get('/me')
      .set('x-forwarded-for', freshIp())
      .set('Cookie', 'ff_guest=s%3Anotaguest.badsig')
      .expect(200);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  it('refuses the 6th new guest from one IP in an hour', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) await http().get('/me').set('x-forwarded-for', ip).expect(200);
    const res = await http().get('/me').set('x-forwarded-for', ip).expect(429);
    expect(res.body).toEqual({ error: 'too many new guests from this network, try in an hour' });
    await http().get('/me').set('x-forwarded-for', freshIp()).expect(200);
  });

  it('never stores a raw ip', async () => {
    const ip = freshIp();
    await http().get('/me').set('x-forwarded-for', ip).expect(200);
    const guests = await prisma.guest.findMany();
    expect(guests.every((g) => g.ipHash.length === 64 && !g.ipHash.includes(ip))).toBe(true);
  });

  it('sets the mode', async () => {
    const agent = request.agent(app.getHttpServer());
    const ip = freshIp();
    await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    await agent.put('/me/mode').set('x-forwarded-for', ip).send({ mode: 'async' }).expect(200);
    const me = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
    expect(me.body.mode).toBe('async');
    await agent.put('/me/mode').set('x-forwarded-for', ip).send({ mode: 'bogus' }).expect(400);
  });

  describe('refill', () => {
    it('is 409 while bundles wait at sew_collar', async () => {
      const agent = request.agent(app.getHttpServer());
      const ip = freshIp();
      await agent.get('/me').set('x-forwarded-for', ip).expect(200);
      const res = await agent.post('/me/bundles/refill').set('x-forwarded-for', ip).expect(409);
      expect(res.body).toEqual({ error: 'finish the bundles you have first' });
    });

    it('adds 3 bundles once none waits at the sewing steps, and stops after 10 a day', async () => {
      const agent = request.agent(app.getHttpServer());
      const ip = freshIp();
      const me = await agent.get('/me').set('x-forwarded-for', ip).expect(200);
      const move = async (to: number) => {
        const guest = await prisma.guest.findUniqueOrThrow({ where: { name: me.body.name } });
        await prisma.bundle.updateMany({ where: { guestId: guest.id }, data: { nextStep: to } });
      };
      for (let i = 0; i < 10; i++) {
        await move(3);
        const r = await agent.post('/me/bundles/refill').set('x-forwarded-for', ip).expect(201);
        expect(r.body.bundles.filter((b: { nextOp: string }) => b.nextOp === 'sew_collar')).toHaveLength(3);
      }
      await move(3);
      await agent.post('/me/bundles/refill').set('x-forwarded-for', ip).expect(429);
    });
  });

  describe('devices', () => {
    it('registers one device per guest and station', async () => {
      const agent = request.agent(app.getHttpServer());
      const ip = freshIp();
      const a = await agent.post('/devices').set('x-forwarded-for', ip).send({ station: 'S-07' }).expect(201);
      const b = await agent.post('/devices').set('x-forwarded-for', ip).send({ station: 'S-07' }).expect(201);
      const c = await agent.post('/devices').set('x-forwarded-for', ip).send({ station: 'S-08' }).expect(201);
      expect(b.body.deviceId).toBe(a.body.deviceId);
      expect(c.body.deviceId).not.toBe(a.body.deviceId);
      expect(typeof a.body.registeredAt).toBe('string');
    });

    it('refuses sim-only stations for guests with 403', async () => {
      await http().post('/devices').set('x-forwarded-for', freshIp()).send({ station: 'X-01' }).expect(403);
    });

    it('rejects an unknown station', async () => {
      await http().post('/devices').set('x-forwarded-for', freshIp()).send({ station: 'Z-99' }).expect(400);
    });

    it('lets the sim register any station once per simName, with no guest created', async () => {
      const before = await prisma.guest.count();
      const send = () =>
        http()
          .post('/devices')
          .set('x-sim-key', process.env.SIM_KEY!)
          .send({ station: 'X-01', simName: 'sim-shipper' })
          .expect(201);
      const a = await send();
      const b = await send();
      expect(b.body.deviceId).toBe(a.body.deviceId);
      const dev = await prisma.device.findUniqueOrThrow({ where: { id: a.body.deviceId } });
      expect(dev).toMatchObject({ code: 'X-01', simName: 'sim-shipper', isSimulated: true, guestId: null });
      expect(await prisma.guest.count()).toBe(before);
    });

    it('ignores x-sim-key from a non-loopback address', async () => {
      await http()
        .post('/devices')
        .set('x-forwarded-for', freshIp())
        .set('x-sim-key', process.env.SIM_KEY!)
        .send({ station: 'X-01', simName: 'sim-shipper' })
        .expect(403);
    });

    it('ignores a wrong x-sim-key from loopback', async () => {
      await http()
        .post('/devices')
        .set('x-sim-key', 'nope')
        .send({ station: 'X-01', simName: 'sim-shipper' })
        .expect(403);
    });
  });
});
