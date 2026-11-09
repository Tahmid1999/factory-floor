import { PrismaClient } from '@prisma/client';
import { wasteOf, wasteOfMany } from '../src/apply/waste';
import { POLO_ROUTE } from '../src/line/line';
import { resetDb } from './helpers';

describe('wasteOfMany', () => {
  let prisma: PrismaClient;
  let queries = 0;

  beforeAll(async () => {
    await resetDb();
    prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
    prisma.$on('query', () => queries++);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  // A bundle with a paid wasted sleeve (240 labour + 290 trims), an unpaid
  // wasted redo of the hem, and a collar that was not wasted.
  async function bundle(code: string) {
    const style = await prisma.style.findUniqueOrThrow({ where: { code: '944' } });
    const b = await prisma.bundle.create({
      data: { code, styleId: style.id, pieces: 20, status: 'rework', nextStep: POLO_ROUTE.indexOf('hem') },
    });
    const at = new Date('2026-11-09T10:00:00Z');
    const event = (op: string, wasted: boolean) =>
      prisma.bundleEvent.create({ data: { bundleId: b.id, op, source: 'batch', round: 0, correctedAt: at, wasted } });
    const collar = await event('sew_collar', false);
    const sleeve = await event('sew_sleeve', true);
    await event('hem', true);
    for (const [e, mills] of [
      [collar, 300],
      [sleeve, 240],
    ] as const) {
      await prisma.posting.create({
        data: { period: '2026-11', kind: 'labour', amountMills: mills, bundleCode: code, eventId: e.id },
      });
    }
    return b.id;
  }

  it('prices each bundle as wasteOf does, in the same few queries for one bundle or five', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await bundle(`B-90${i}`));

    queries = 0;
    const one = await wasteOfMany(prisma, ids.slice(0, 1));
    const forOne = queries;
    queries = 0;
    const five = await wasteOfMany(prisma, ids);
    const forFive = queries;

    expect(one.get(ids[0])).toBe(530);
    expect([...five.values()]).toEqual([530, 530, 530, 530, 530]);
    for (const id of ids) expect(await wasteOf(prisma, id)).toBe(five.get(id));
    expect(forFive).toBe(forOne);
    expect((await wasteOfMany(prisma, ['nope'])).get('nope')).toBe(0);
  });
});
