import { Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';

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
