import { Controller, Get, HttpException, Inject, INestApplication, Post, Query } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { CLOCK, Clock, FixedClock } from '../src/clock';
import { audit } from '../src/audit/audit';
import { Reads, Writes } from '../src/auth/roles';
import { PrismaService } from '../src/prisma.service';
import { bootApi, resetDb } from './helpers';

process.env.ADMIN_JWT_SECRET ??= 'test-only-admin-jwt-secret';

// Stands in for the real admin routes, which arrive later; the guard only
// cares about the decorators.
@Controller('t')
class TestController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('held')
  @Reads('held')
  held() {
    return { ok: true };
  }

  @Get('floor')
  @Reads('floor')
  floor() {
    return { ok: true };
  }

  @Get('open')
  open() {
    return { ok: true };
  }

  @Post('write')
  @Writes()
  async write(@Query('fail') fail?: string) {
    await this.prisma.$transaction(async (tx) => {
      await audit(tx, { actor: 'tahmid', role: 'admin', action: 't.write', entity: 'test', after: { n: 1 } }, this.clock);
      if (fail) throw new HttpException({ error: 'boom' }, 500);
    });
    return { ok: true };
  }
}

// Supertest connects from loopback, so each test fakes its client address the
// way the production proxy reports it.
let nextIp = 50;
const freshIp = () => `203.0.113.${nextIp++}`;

describe('roles, admin login and audit', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaClient();
    await prisma.user.upsert({
      where: { login: 'tahmid' },
      update: { passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
      create: { login: 'tahmid', passwordHash: bcrypt.hashSync('right-password', 4), role: 'admin' },
    });
    await prisma.user.upsert({
      where: { login: 'quinn' },
      update: { passwordHash: bcrypt.hashSync('qc-password', 4), role: 'qc' },
      create: { login: 'quinn', passwordHash: bcrypt.hashSync('qc-password', 4), role: 'qc' },
    });
    app = await bootApi({ clock, extraControllers: [TestController] });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function loginCookie(ip = freshIp()): Promise<string> {
    const res = await http()
      .post('/admin/login')
      .set('x-forwarded-for', ip)
      .send({ login: 'tahmid', password: 'right-password' })
      .expect(200);
    return res.headers['set-cookie'][0].split(';')[0];
  }

  it('refuses a view outside the acting role with the exact message', async () => {
    const res = await http().get('/t/held?as=accounts').expect(403);
    expect(res.body).toEqual({ error: 'accounts cannot see held' });
  });

  it('lets a role read its own view', async () => {
    await http().get('/t/floor?as=operator').expect(200);
  });

  it('defaults an anonymous reader to admin', async () => {
    await http().get('/t/held').expect(200);
  });

  it('rejects an unknown role', async () => {
    const res = await http().get('/t/held?as=janitor').expect(400);
    expect(res.body).toEqual({ error: 'unknown role' });
  });

  it('leaves a route with no decorator alone', async () => {
    await http().get('/t/open?as=janitor').expect(200);
  });

  it('refuses a write without the cookie', async () => {
    await http().post('/t/write').expect(401);
  });

  it('refuses a write with a forged cookie', async () => {
    await http().post('/t/write').set('Cookie', 'ff_admin=not.a.jwt').expect(401);
  });

  it('sets an httpOnly, SameSite=Lax cookie that lasts 12 hours', async () => {
    const res = await http()
      .post('/admin/login')
      .set('x-forwarded-for', freshIp())
      .send({ login: 'tahmid', password: 'right-password' })
      .expect(200);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/^ff_admin=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/Max-Age=43200/);
  });

  it('accepts a write with the cookie, and the admin can still preview a role', async () => {
    const cookie = await loginCookie();
    await http().post('/t/write').set('Cookie', cookie).expect(201);
    const res = await http().get('/t/held?as=accounts').set('Cookie', cookie).expect(403);
    expect(res.body).toEqual({ error: 'accounts cannot see held' });
    await http().get('/t/held').set('Cookie', cookie).expect(200);
  });

  it('tells the page who is logged in, and says nothing for anyone else', async () => {
    const cookie = await loginCookie();
    const res = await http().get('/admin/session').set('Cookie', cookie).expect(200);
    expect(res.body).toEqual({ login: 'tahmid', role: 'admin' });
    const anon = await http().get('/admin/session').expect(200);
    expect(anon.text).toBe('');
    const forged = await http().get('/admin/session').set('Cookie', 'ff_admin=not.a.jwt').expect(200);
    expect(forged.text).toBe('');
  });

  it('ends the session on logout', async () => {
    const res = await http().post('/admin/logout').expect(200);
    expect(res.headers['set-cookie'][0]).toMatch(/^ff_admin=;/);
  });

  it('answers the 6th wrong password from one ip with 429', async () => {
    const ip = freshIp();
    const wrong = () => http().post('/admin/login').set('x-forwarded-for', ip).send({ login: 'tahmid', password: 'nope' });
    for (let i = 0; i < 5; i++) await wrong().expect(401);
    const res = await wrong().expect(429);
    expect(res.body).toEqual({ error: 'too many tries, wait an hour' });
  });

  it('bounds a burst of parallel wrong passwords to the cap', async () => {
    const ip = freshIp();
    const statuses = await Promise.all(
      Array.from({ length: 20 }, () =>
        http().post('/admin/login').set('x-forwarded-for', ip).send({ login: 'tahmid', password: 'nope' }).then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 401).length).toBeLessThanOrEqual(5);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(15);
  });

  it('refuses a write from a logged-in non-admin, even with ?as=admin', async () => {
    const login = await http()
      .post('/admin/login')
      .set('x-forwarded-for', freshIp())
      .send({ login: 'quinn', password: 'qc-password' })
      .expect(200);
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const res = await http().post('/t/write').set('Cookie', cookie).expect(403);
    expect(res.body).toEqual({ error: 'qc cannot write' });
    await http().post('/t/write?as=admin').set('Cookie', cookie).expect(403);
  });

  it('does not count successful logins against the limit', async () => {
    const ip = freshIp();
    for (let i = 0; i < 7; i++) await loginCookie(ip);
  });

  it('keeps a locked-out ip locked even with the right password', async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) {
      await http().post('/admin/login').set('x-forwarded-for', ip).send({ login: 'tahmid', password: 'nope' }).expect(401);
    }
    await http().post('/admin/login').set('x-forwarded-for', ip).send({ login: 'tahmid', password: 'right-password' }).expect(429);
  });

  it('writes the audit row when the audited action succeeds', async () => {
    const cookie = await loginCookie();
    await http().post('/t/write').set('Cookie', cookie).expect(201);
    const rows = await prisma.auditLog.findMany({ where: { action: 't.write' } });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({ actor: 'tahmid', role: 'admin', entity: 'test', at: clock.now() });
  });

  it('rolls the audit row back when the action throws after audit()', async () => {
    const cookie = await loginCookie();
    const before = await prisma.auditLog.count();
    await http().post('/t/write?fail=1').set('Cookie', cookie).expect(500);
    expect(await prisma.auditLog.count()).toBe(before);
  });
});
