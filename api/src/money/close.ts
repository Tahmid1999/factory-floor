import { BadRequestException } from '@nestjs/common';
import { PeriodClose, Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { audit } from '../audit/audit';
import { periodBounds, periodOf } from './period';
import { pnlLines, wipAt } from './pnl';
import { lockPeriod } from './postings';

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Integer mills to dollars without floats, as the admin shows them.
export function dollars(mills: number): string {
  const cents = Math.round(mills / 10);
  const sign = cents < 0 ? '-' : '';
  const c = Math.abs(cents);
  return `${sign}$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

// A month is closed once and never reopened. The exclusive lock waits for
// every posting that saw the month open to commit, and holds off any that
// start meanwhile; those find the PeriodClose row once it is granted and go
// to the current month as adjustments. So the snapshot below is final.
export async function closeMonth(
  tx: Tx,
  now: Date,
  period: string,
  actor: string,
  role = 'system',
): Promise<{ closed: boolean; close: PeriodClose }> {
  if (period >= periodOf(now)) throw new BadRequestException({ error: 'month not over' });
  // Only right under READ COMMITTED: each statement after the lock takes a
  // fresh snapshot, so it sees every posting that held the shared lock. Never
  // run this in RepeatableRead or Serializable as the P&L read is, or the
  // snapshot is taken before the lock is granted and misses them.
  await lockPeriod(tx, period, 'exclusive');
  const existing = await tx.periodClose.findUnique({ where: { period } });
  if (existing) return { closed: false, close: existing };

  const wip = await wipAt(tx, periodBounds(period).end);
  const totals = await pnlLines(tx, period, { excludeSim: false });
  const close = await tx.periodClose.create({
    data: {
      period,
      closedAt: now,
      closedBy: actor,
      wipMills: wip.all,
      wipGuestMills: wip.guest,
      totals: totals as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(
    tx,
    {
      actor,
      role,
      action: 'month_close',
      entity: `period:${period}`,
      after: { wipMills: wip.all, wipGuestMills: wip.guest, totals },
    },
    { now: () => now },
  );
  return { closed: true, close };
}
