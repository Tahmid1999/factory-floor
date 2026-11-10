import { BadRequestException } from '@nestjs/common';
import { PeriodClose, Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { audit } from '../audit/audit';
import { periodBounds, periodOf } from './period';
import { pnlLines } from './pnl';
import { lockPeriod } from './postings';

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

// Integer mills to dollars without floats, as the admin shows them.
export function dollars(mills: number): string {
  const cents = Math.round(mills / 10);
  const sign = cents < 0 ? '-' : '';
  const c = Math.abs(cents);
  return `${sign}$${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
}

// What the line held at the instant the month ended: bundles cut before it and
// neither shipped nor scrapped before it, valued at what had been spent on them
// by then. A memo line: those costs are already in the month's P&L as incurred.
// One statement: the seeded month ends with tens of thousands of bundles.
async function wipAt(tx: Tx, end: Date): Promise<{ all: number; guest: number }> {
  const [r] = await tx.$queryRaw<{ wip: bigint; guest: bigint }[]>`
    WITH wip AS (
      SELECT c."bundleId"
      FROM "BundleEvent" c
      WHERE c."op" = 'cut' AND c."correctedAt" < ${end}
        AND NOT EXISTS (
          SELECT 1 FROM "BundleEvent" d
          WHERE d."bundleId" = c."bundleId" AND d."op" IN ('ship', 'scrap') AND d."correctedAt" < ${end}
        )
    )
    SELECT COALESCE(SUM(p."amountMills"), 0)::bigint AS wip,
           COALESCE(SUM(p."amountMills") FILTER (WHERE NOT b."isSimulated"), 0)::bigint AS guest
    FROM wip w
    JOIN "Bundle" b ON b."id" = w."bundleId"
    JOIN "BundleEvent" e ON e."bundleId" = w."bundleId" AND e."correctedAt" < ${end}
    JOIN "Posting" p ON p."eventId" = e."id" AND p."kind" IN ('fabric', 'labour', 'trims')`;
  return { all: Number(r.wip), guest: Number(r.guest) };
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
