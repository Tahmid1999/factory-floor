import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, Roll } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { audit } from '../audit/audit';
import { post } from '../money/postings';

export const ROLL_CM = 30_000;
export const BUNDLE_CM = 1800;
export const TEST_ROLL_CM = 10_000;

export const ADJUST_REASONS = ['count', 'damaged', 'found'] as const;
export type AdjustReason = (typeof ADJUST_REASONS)[number];

// Thrown inside the cut's transaction so the bundle, its event and its
// postings roll back with it; the edges turn it into their own answer.
export class OutOfFabric extends Error {
  constructor() {
    super('no roll holds a bundle of fabric');
  }
}

// Cost is per metre and lengths are centimetres. Rounded half away from zero,
// so a gain and a loss of the same length are the same sum.
export function millsFor(cm: number, costPerMetreMills: number): number {
  const n = cm * costPerMetreMills;
  return Math.sign(n) * Math.round(Math.abs(n) / 100);
}

// No remnants are kept: a cut that would leave less than a bundle takes it all.
export function cutTake(onHand: number): number {
  return onHand - BUNDLE_CM < BUNDLE_CM ? onHand : BUNDLE_CM;
}

export async function onHandCm(tx: Tx, rollId: string): Promise<number> {
  const r = await tx.stockMovement.aggregate({ where: { rollId }, _sum: { deltaCm: true } });
  return r._sum.deltaCm ?? 0;
}

const onHandSql = Prisma.sql`(SELECT COALESCE(SUM(m."deltaCm"), 0) FROM "StockMovement" m WHERE m."rollId" = r."id")`;

// Rolls are never deleted, so without the emptiedAt filter every pick would sum
// the whole history of the store.
const openRoll = Prisma.sql`NOT r."isTest" AND r."emptiedAt" IS NULL`;

export async function cuttableRolls(tx: Tx): Promise<number> {
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM "Roll" r WHERE ${openRoll} AND ${onHandSql} >= ${BUNDLE_CM}`;
  return n;
}

// The movement that takes a roll to 0 stamps it, in the same transaction, and
// an adjust that adds fabric back clears the stamp.
async function markEmptied(tx: Tx, roll: Roll, after: number, now: Date): Promise<void> {
  const emptiedAt = after === 0 ? now : null;
  if ((roll.emptiedAt === null) === (emptiedAt === null)) return;
  await tx.roll.update({ where: { id: roll.id }, data: { emptiedAt } });
}

// The sum is the truth; the roll row is only the mutex. On-hand is never
// stored, because a cached balance can drift from the ledger. Locking the roll
// row queues the cuts on one roll behind each other, and the SUM after the
// lock, a new statement under READ COMMITTED, sees every cut that went before.
// emptiedAt is only a filter hint that keeps the pick off rolls already used
// up; it never decides how much a roll holds.
//
// The pick and the lock are one statement, but its SUM is from before the lock
// was granted. So a cut that waited sums again, and if the roll ran short in
// the meantime it picks again: that pick sees the other cut and moves on.
export async function issueForBundle(
  tx: Tx,
  now: Date,
  o: { bundleCode: string; actor: string; isSimulated: boolean; eventId: string; guestId: string | null },
): Promise<{ rollCode: string; cm: number; mills: number } | null> {
  for (;;) {
    const [roll] = await tx.$queryRaw<Roll[]>`
      SELECT r.* FROM "Roll" r
      WHERE ${openRoll} AND ${onHandSql} >= ${BUNDLE_CM}
      ORDER BY r."receivedAt", r."code"
      LIMIT 1
      FOR UPDATE OF r`;
    if (!roll) return null;
    const onHand = await onHandCm(tx, roll.id);
    if (onHand < BUNDLE_CM) continue;

    const cm = cutTake(onHand);
    const mills = millsFor(cm, roll.costPerMetreMills);
    await tx.stockMovement.create({
      data: {
        rollId: roll.id,
        kind: 'issue_to_cutting',
        deltaCm: -cm,
        bundleCode: o.bundleCode,
        actor: o.actor,
        isSimulated: o.isSimulated,
        at: now,
      },
    });
    await markEmptied(tx, roll, onHand - cm, now);
    await post(tx, now, {
      kind: 'fabric',
      amountMills: mills,
      at: now,
      bundleCode: o.bundleCode,
      eventId: o.eventId,
      guestId: o.guestId,
      isSimulated: o.isSimulated,
    });
    return { rollCode: roll.code, cm, mills };
  }
}

// The same lock and sum on a roll named up front, with no posting: the
// stress button's test rolls carry no money.
export async function issueFromRoll(tx: Tx, now: Date, rollId: string, cm: number, actor: string): Promise<boolean> {
  const [roll] = await tx.$queryRaw<Roll[]>`SELECT * FROM "Roll" WHERE "id" = ${rollId} FOR UPDATE`;
  if (!roll) return false;
  const onHand = await onHandCm(tx, roll.id);
  if (onHand < cm) return false;
  await tx.stockMovement.create({
    data: { rollId, kind: 'issue_to_cutting', deltaCm: -cm, actor, isSimulated: roll.isSimulated, at: now },
  });
  await markEmptied(tx, roll, onHand - cm, now);
  return true;
}

export async function receive(
  tx: Tx,
  now: Date,
  o: { count: number; costPerMetreMills: number; actor: string; isSimulated: boolean },
): Promise<Roll[]> {
  const seq = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT nextval('roll_code_seq') AS n FROM generate_series(1, ${o.count}::int)`;
  const rolls: Roll[] = [];
  for (const { n } of seq) {
    rolls.push(
      await tx.roll.create({
        data: {
          code: `R-${n}`,
          lengthCm: ROLL_CM,
          costPerMetreMills: o.costPerMetreMills,
          receivedAt: now,
          isSimulated: o.isSimulated,
          movements: {
            create: { kind: 'receive', deltaCm: ROLL_CM, actor: o.actor, isSimulated: o.isSimulated, at: now },
          },
        },
      }),
    );
  }
  return rolls;
}

export async function receiveTestRoll(tx: Tx, now: Date): Promise<Roll> {
  const [{ n }] = await tx.$queryRaw<{ n: bigint }[]>`SELECT nextval('test_roll_code_seq') AS n`;
  return tx.roll.create({
    data: {
      code: `T-${String(n).padStart(4, '0')}`,
      lengthCm: TEST_ROLL_CM,
      costPerMetreMills: 0,
      receivedAt: now,
      isTest: true,
      isSimulated: false,
      movements: {
        create: { kind: 'receive', deltaCm: TEST_ROLL_CM, actor: 'stress', isSimulated: false, at: now },
      },
    },
  });
}

// A stock count that differs from the ledger is booked as a movement and
// costed at the roll's price. A loss is a positive cost and a find a negative
// one: the P&L subtracts adjustments either way.
export async function adjust(
  tx: Tx,
  now: Date,
  who: { login: string; role: string },
  a: { rollCode: string; deltaCm: number; reason: AdjustReason },
): Promise<{ rollCode: string; onHandCm: number; amountMills: number }> {
  if (a.reason === 'damaged' && a.deltaCm > 0) throw new BadRequestException({ error: 'damaged fabric can only go down' });
  if (a.reason === 'found' && a.deltaCm < 0) throw new BadRequestException({ error: 'found fabric can only go up' });
  // A test roll is the stress button's and carries no money, so it is not adjustable.
  const [roll] = await tx.$queryRaw<Roll[]>`
    SELECT * FROM "Roll" WHERE "code" = ${a.rollCode} AND NOT "isTest" FOR UPDATE`;
  if (!roll) throw new NotFoundException({ error: 'no such roll' });
  const before = await onHandCm(tx, roll.id);
  const after = before + a.deltaCm;
  if (after < 0) throw new ConflictException({ error: `${roll.code} holds ${before} cm` });

  await tx.stockMovement.create({
    data: { rollId: roll.id, kind: 'adjust', deltaCm: a.deltaCm, actor: who.login, reason: a.reason, isSimulated: false, at: now },
  });
  await markEmptied(tx, roll, after, now);
  const amountMills = millsFor(-a.deltaCm, roll.costPerMetreMills);
  await post(tx, now, { kind: 'adjustment', amountMills, at: now, bundleCode: null, isSimulated: false });
  await audit(
    tx,
    {
      actor: who.login,
      role: who.role,
      action: 'stock_adjust',
      entity: `roll:${roll.code}`,
      before: { onHandCm: before },
      after: { onHandCm: after, deltaCm: a.deltaCm, reason: a.reason, amountMills },
    },
    { now: () => now },
  );
  return { rollCode: roll.code, onHandCm: after, amountMills };
}
