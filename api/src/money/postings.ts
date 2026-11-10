import { Posting, PostingKind, Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { periodOf } from './period';

// Month close takes the exclusive variant, post() the shared one, so a
// posting that saw the month open cannot commit after close has read the
// totals. Many postings still run at once; only a close waits for them.
export const PERIOD_LOCK_SQL = {
  shared: Prisma.raw('pg_advisory_xact_lock_shared'),
  exclusive: Prisma.raw('pg_advisory_xact_lock'),
};

export async function lockPeriod(tx: Tx, period: string, mode: keyof typeof PERIOD_LOCK_SQL): Promise<void> {
  await tx.$executeRaw`SELECT ${PERIOD_LOCK_SQL[mode]}(hashtext(${'period:' + period}))`;
}

export type NewPosting = {
  kind: PostingKind;
  amountMills: number;
  // When the thing happened. now, not at, is when it is written.
  at: Date;
  bundleCode: string | null;
  eventId?: string;
  guestId?: string | null;
  isSimulated: boolean;
};

// The only writer of Posting. A closed month is never reopened: work dated
// into it is booked in the month of now and points back at the one it
// adjusts. createdAt is now, not the wall clock, because the seeded month
// runs on a fast clock.
export async function post(tx: Tx, now: Date, p: NewPosting): Promise<Posting> {
  const dated = periodOf(p.at);
  await lockPeriod(tx, dated, 'shared');
  const closed = await tx.periodClose.findUnique({ where: { period: dated } });
  return tx.posting.create({
    data: {
      period: closed ? periodOf(now) : dated,
      adjustsPeriod: closed ? dated : null,
      kind: p.kind,
      amountMills: p.amountMills,
      bundleCode: p.bundleCode,
      eventId: p.eventId,
      guestId: p.guestId,
      isSimulated: p.isSimulated,
      createdAt: now,
    },
  });
}
