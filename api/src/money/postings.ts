import { Posting, PostingKind, Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { nextPeriod, periodOf } from './period';

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
// into it is booked in the first open month from now on and points back at
// the one it adjusts. createdAt is now, not the wall clock, because the
// seeded month runs on a fast clock.
//
// Every month it looks at is locked shared before its PeriodClose is read.
// Month close takes the same lock exclusively and writes PeriodClose under
// it, so a posting cannot slip into a month whose close is running, and a
// stale now (read once per transaction) cannot land in a month that closed
// since.
export async function post(tx: Tx, now: Date, p: NewPosting): Promise<Posting> {
  const dated = periodOf(p.at);
  let period = dated;
  for (;;) {
    await lockPeriod(tx, period, 'shared');
    if (!(await tx.periodClose.findUnique({ where: { period } }))) break;
    const next = nextPeriod(period);
    const current = periodOf(now);
    period = next > current ? next : current;
  }
  return tx.posting.create({
    data: {
      period,
      adjustsPeriod: period === dated ? null : dated,
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
