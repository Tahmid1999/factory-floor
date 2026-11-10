import { PrismaClient } from '@prisma/client';
import { FixedClock } from '../src/clock';
import { post } from '../src/money/postings';
import { bootApi, bootWorker, makeGuest, purgeQueues, resetDb, until } from './helpers';

// Runs as ff_app, the same role the API uses.
describe('post()', () => {
  const prisma = new PrismaClient();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.TEST_OWNER_DATABASE_URL } } });

  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  const labour = (at: Date) => ({
    kind: 'labour' as const,
    amountMills: 200,
    at,
    bundleCode: 'B-8492',
    isSimulated: false,
  });

  it('books into the month of the work while that month is open', async () => {
    const now = new Date('2026-10-31T23:58:30Z');
    const row = await prisma.$transaction((tx) => post(tx, now, labour(new Date('2026-10-31T23:58:00Z'))));
    expect(row.period).toBe('2026-10');
    expect(row.adjustsPeriod).toBeNull();
  });

  it('stamps createdAt from the clock it is given, not the wall', async () => {
    const now = new Date('2026-10-31T23:58:30Z');
    const row = await prisma.$transaction((tx) => post(tx, now, labour(now)));
    expect(row.createdAt).toEqual(now);
  });

  it('moves a posting for a closed month into the current one and says which it adjusts', async () => {
    await prisma.periodClose.create({
      data: { period: '2026-10', closedAt: new Date('2026-10-31T23:59:00Z'), closedBy: 'tahmid', wipMills: 0, wipGuestMills: 0, totals: {} },
    });
    const now = new Date('2026-11-01T00:30:00Z');
    const row = await prisma.$transaction((tx) => post(tx, now, labour(new Date('2026-10-31T23:58:00Z'))));
    expect(row.period).toBe('2026-11');
    expect(row.adjustsPeriod).toBe('2026-10');
  });

  it('skips every closed month from now on, and still names the month it adjusts', async () => {
    for (const period of ['2026-10', '2026-11']) {
      await prisma.periodClose.create({
        data: { period, closedAt: new Date('2026-11-30T00:00:00Z'), closedBy: 'tahmid', wipMills: 0, wipGuestMills: 0, totals: {} },
      });
    }
    const now = new Date('2026-11-30T23:59:00Z');
    const row = await prisma.$transaction((tx) => post(tx, now, labour(new Date('2026-10-31T10:00:00Z'))));
    expect(row.period).toBe('2026-12');
    expect(row.adjustsPeriod).toBe('2026-10');
  });

  it('keeps the sign of an adjustment and a null bundle code', async () => {
    const at = new Date('2026-10-05T10:00:00Z');
    const row = await prisma.$transaction((tx) =>
      post(tx, at, { kind: 'adjustment', amountMills: -3400, at, bundleCode: null, isSimulated: false }),
    );
    expect(row.amountMills).toBe(-3400);
    expect(row.bundleCode).toBeNull();
  });
});

describe('stock ledger grants', () => {
  const prisma = new PrismaClient();
  const owner = new PrismaClient({ datasources: { db: { url: process.env.TEST_OWNER_DATABASE_URL } } });

  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  async function pgCode(run: () => Promise<unknown>): Promise<{ code?: string; message: string } | undefined> {
    try {
      await run();
    } catch (e: any) {
      return { code: e.meta?.code ?? e.code, message: String(e.meta?.message ?? e.message) };
    }
    return undefined;
  }

  async function movement(code: string, isTest: boolean) {
    const at = new Date('2026-10-02T08:00:00Z');
    const roll = await prisma.roll.create({
      data: { code, lengthCm: 30000, costPerMetreMills: 3400, receivedAt: at, isTest, isSimulated: true },
    });
    return prisma.stockMovement.create({
      data: { rollId: roll.id, kind: 'receive', deltaCm: 30000, actor: 'sim', isSimulated: true, at },
    });
  }

  it('refuses UPDATE with 42501', async () => {
    const m = await movement('R-1', false);
    const err = await pgCode(() => prisma.$executeRaw`UPDATE "StockMovement" SET "deltaCm" = 1 WHERE id = ${m.id}`);
    expect(err?.code).toBe('42501');
  });

  it('refuses to flip isTest on a real roll, so its history stays undeletable', async () => {
    const m = await movement('R-5', false);
    const err = await pgCode(() => prisma.roll.update({ where: { id: m.rollId }, data: { isTest: true } }));
    expect(err?.message).toContain('isTest cannot change');
    const del = await pgCode(() => prisma.stockMovement.delete({ where: { id: m.id } }));
    expect(del?.message).toContain('append-only');
  });

  it('refuses DELETE of a movement on a real roll', async () => {
    const m = await movement('R-2', false);
    const err = await pgCode(() => prisma.stockMovement.delete({ where: { id: m.id } }));
    expect(err?.message).toContain('append-only');
  });

  it('allows DELETE of a movement on a test roll', async () => {
    const m = await movement('R-3', true);
    await prisma.stockMovement.delete({ where: { id: m.id } });
    expect(await prisma.stockMovement.count({ where: { id: m.id } })).toBe(0);
  });

  it('refuses UPDATE even for the owner role, through the trigger', async () => {
    const m = await movement('R-4', false);
    const err = await pgCode(() => owner.$executeRaw`UPDATE "StockMovement" SET "deltaCm" = 1 WHERE id = ${m.id}`);
    expect(err?.message).toContain('append-only');
  });
});

describe('a slice-1 labour step into a closed month', () => {
  const prisma = new PrismaClient();

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('is booked in the current month and adjusts the closed one', async () => {
    await resetDb();
    await purgeQueues();
    const clock = new FixedClock(new Date('2026-10-31T23:50:00Z'));
    const api = await bootApi(clock);
    const worker = await bootWorker(clock);
    try {
      const g = await makeGuest(api, clock, ['S-07']);
      await prisma.periodClose.create({
        data: { period: '2026-10', closedAt: clock.now(), closedBy: 'tahmid', wipMills: 0, wipGuestMills: 0, totals: {} },
      });
      // Scanned at 23:51 on Oct 31, received after midnight.
      clock.advance(40 * 60_000);
      await g.batch('S-07', [g.ev(1, g.codes[0], 'sew_collar', 39 * 60_000)]).expect(201);
      const posting = await until(() =>
        prisma.posting.findFirst({ where: { bundleCode: g.codes[0], kind: 'labour', adjustsPeriod: { not: null } } }),
      );
      expect(posting!.period).toBe('2026-11');
      expect(posting!.adjustsPeriod).toBe('2026-10');
    } finally {
      await worker.close();
      await api.close();
    }
  });
});
