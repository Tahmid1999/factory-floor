import { PeriodClose, Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { periodBounds } from './period';

export type PnlLines = {
  revenue: number;
  fabric: number;
  trims: number;
  labour: number;
  adjustment: number;
  // Rows booked this month for work dated in a closed one, signed as the P&L
  // reads them: revenue up, costs down.
  late: { from: string; mills: number }[];
  contribution: number;
  writeoff: number;
};

const COSTS = ['fabric', 'trims', 'labour', 'adjustment'] as const;

// The one place a month's lines are summed: the close stores this as its
// snapshot and the P&L reads it live, so the two cannot disagree. Grouping is
// done in SQL; what comes back is at most kinds x months rows.
//
// Write-off is a memo line and never subtracted: the fabric and labour it
// names were booked as costs when they happened.
export async function pnlLines(tx: Tx, period: string, o: { excludeSim: boolean }): Promise<PnlLines> {
  const sim = o.excludeSim ? Prisma.sql`AND NOT "isSimulated"` : Prisma.empty;
  const rows = await tx.$queryRaw<{ kind: string; adjustsPeriod: string | null; mills: bigint }[]>`
    SELECT "kind"::text AS kind, "adjustsPeriod", SUM("amountMills")::bigint AS mills
    FROM "Posting"
    WHERE "period" = ${period} ${sim}
    GROUP BY "kind", "adjustsPeriod"
    ORDER BY "adjustsPeriod" NULLS FIRST`;

  const lines: PnlLines = {
    revenue: 0,
    fabric: 0,
    trims: 0,
    labour: 0,
    adjustment: 0,
    late: [],
    contribution: 0,
    writeoff: 0,
  };
  const late = new Map<string, number>();
  for (const r of rows) {
    const mills = Number(r.mills);
    const sign = r.kind === 'revenue' ? 1 : (COSTS as readonly string[]).includes(r.kind) ? -1 : 0;
    lines.contribution += sign * mills;
    if (r.adjustsPeriod === null) {
      lines[r.kind as keyof Omit<PnlLines, 'late' | 'contribution'>] += mills;
    } else if (sign !== 0) {
      late.set(r.adjustsPeriod, (late.get(r.adjustsPeriod) ?? 0) + sign * mills);
    }
  }
  lines.late = [...late].map(([from, mills]) => ({ from, mills }));
  return lines;
}

// What the line held at the instant the month ended: bundles cut before it and
// neither shipped nor scrapped before it, valued at what had been spent on them
// by then. A memo line: those costs are already in the month's P&L as incurred.
// One statement: the seeded month ends with tens of thousands of bundles.
export async function wipAt(tx: Tx, end: Date): Promise<{ all: number; guest: number }> {
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

// WIP as of now, driven from the bundles still on the line instead of the
// whole event history: status is set to shipped/scrapped by the same
// transactions that write those events. Same result as wipAt(tx, now).
export async function wipLive(tx: Tx, now: Date): Promise<{ all: number; guest: number }> {
  const [r] = await tx.$queryRaw<{ wip: bigint; guest: bigint }[]>`
    SELECT COALESCE(SUM(p."amountMills"), 0)::bigint AS wip,
           COALESCE(SUM(p."amountMills") FILTER (WHERE NOT b."isSimulated"), 0)::bigint AS guest
    FROM "Bundle" b
    JOIN "BundleEvent" e ON e."bundleId" = b."id" AND e."correctedAt" < ${now}
    JOIN "Posting" p ON p."eventId" = e."id" AND p."kind" IN ('fabric', 'labour', 'trims')
    WHERE b."status" IN ('active', 'rework', 'packed')
      AND EXISTS (SELECT 1 FROM "BundleEvent" c WHERE c."bundleId" = b."id" AND c."op" = 'cut' AND c."correctedAt" < ${now})
      AND NOT EXISTS (
        SELECT 1 FROM "BundleEvent" d
        WHERE d."bundleId" = b."id" AND d."op" IN ('ship', 'scrap') AND d."correctedAt" < ${now}
      )`;
  return { all: Number(r.wip), guest: Number(r.guest) };
}

export type Pnl = PnlLines & {
  period: string;
  closed: PeriodClose | null;
  wip: { mills: number; asOf: string };
};

// pnlLines plus what the month closed as and the line's WIP. A closed month
// reads WIP from its snapshot, as of its end; an open one is valued as of now.
export async function pnlOf(tx: Tx, period: string, o: { excludeSim: boolean; now: Date }): Promise<Pnl> {
  const closed = await tx.periodClose.findUnique({ where: { period } });
  const lines = await pnlLines(tx, period, { excludeSim: o.excludeSim });
  if (closed) {
    const mills = o.excludeSim ? closed.wipGuestMills : closed.wipMills;
    return { period, closed, ...lines, wip: { mills, asOf: periodBounds(period).end.toISOString() } };
  }
  const live = await wipLive(tx, o.now);
  return { period, closed, ...lines, wip: { mills: o.excludeSim ? live.guest : live.all, asOf: o.now.toISOString() } };
}
