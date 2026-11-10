import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../apply/steps';
import { deviceLabel } from '../hood/hood';

export const PURGED_KEY = 'purged';

export type PayrollRow = {
  worker: string;
  // Opaque: stands in for the device id, which the admin never shows.
  key: string;
  kind: 'sim' | 'guest' | 'purged';
  pieces: number;
  paidPieces: number;
  earningsMills: number;
};

export type PayrollScan = {
  at: string;
  bundleCode: string;
  op: string;
  round: number;
  pieces: number;
  mills: number;
};

// A UTC day, YYYY-MM-DD, that is a real date.
export function dayBounds(day: string): { start: Date; end: Date } {
  const start = new Date(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== day) {
    throw new BadRequestException({ error: 'day must be YYYY-MM-DD' });
  }
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const KEY_OF = Prisma.sql`left(encode(sha256(convert_to(e."deviceId", 'UTF8')), 'hex'), 16)`;

// Only ops that carry a piece rate are paid work. The pay is whatever labour
// posting the event wrote: a redo wrote none, so its pieces count but earn 0.
const SCANS = (start: Date, end: Date) => Prisma.sql`
  FROM "BundleEvent" e
  JOIN "Bundle" b ON b."id" = e."bundleId"
  LEFT JOIN LATERAL (
    SELECT COUNT(*) AS n, COALESCE(SUM(p."amountMills"), 0) AS mills
    FROM "Posting" p WHERE p."eventId" = e."id" AND p."kind" = 'labour'
  ) l ON true
  WHERE e."correctedAt" >= ${start} AND e."correctedAt" < ${end}
    AND e."deviceId" IS NOT NULL
    AND e."op" IN (SELECT DISTINCT "op" FROM "PieceRate")`;

export async function payrollOf(tx: Tx, day: string): Promise<PayrollRow[]> {
  const { start, end } = dayBounds(day);
  const sums = await tx.$queryRaw<
    { deviceId: string; key: string; pieces: bigint; paid: bigint | null; mills: bigint }[]
  >`
    SELECT e."deviceId", ${KEY_OF} AS key, SUM(b."pieces")::bigint AS pieces,
           SUM(b."pieces") FILTER (WHERE l.n > 0)::bigint AS paid, SUM(l.mills)::bigint AS mills
    ${SCANS(start, end)}
    GROUP BY e."deviceId"`;
  const devices = await tx.device.findMany({
    where: { id: { in: sums.map((s) => s.deviceId) } },
    include: { guest: { select: { name: true } } },
  });
  const byId = new Map(devices.map((d) => [d.id, d]));

  const rows: PayrollRow[] = sums.flatMap((s) => {
    const d = byId.get(s.deviceId);
    if (!d) return [];
    const label = deviceLabel(d);
    return [
      {
        worker: d.isSimulated ? (d.simName ?? label) : `${d.guest?.name ?? 'guest'} · ${label}`,
        key: s.key,
        kind: d.isSimulated ? ('sim' as const) : ('guest' as const),
        pieces: Number(s.pieces),
        paidPieces: Number(s.paid ?? 0),
        earningsMills: Number(s.mills),
      },
    ];
  });
  rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.worker.localeCompare(b.worker));

  // The purge deletes the event with its guest and leaves the posting behind,
  // so what is left of that pay has no scan to list.
  const [gone] = await tx.$queryRaw<{ n: bigint; mills: bigint }[]>`
    SELECT COUNT(*) AS n, COALESCE(SUM(p."amountMills"), 0)::bigint AS mills
    FROM "Posting" p
    WHERE p."kind" = 'labour' AND p."guestPurged"
      AND p."createdAt" >= ${start} AND p."createdAt" < ${end}
      AND NOT EXISTS (SELECT 1 FROM "BundleEvent" e WHERE e."id" = p."eventId")`;
  if (Number(gone.n) > 0) {
    rows.push({
      worker: 'purged guests',
      key: PURGED_KEY,
      kind: 'purged',
      pieces: 0,
      paidPieces: 0,
      earningsMills: Number(gone.mills),
    });
  }
  return rows;
}

export async function scansOf(tx: Tx, day: string, key: string): Promise<PayrollScan[]> {
  const { start, end } = dayBounds(day);
  if (key === PURGED_KEY) return [];
  const rows = await tx.$queryRaw<
    { at: Date; code: string; op: string; round: number; pieces: number; mills: bigint }[]
  >`
    SELECT e."correctedAt" AS at, b."code", e."op", e."round", b."pieces", l.mills::bigint AS mills
    ${SCANS(start, end)} AND ${KEY_OF} = ${key}
    ORDER BY e."correctedAt", e."id"`;
  return rows.map((r) => ({
    at: r.at.toISOString(),
    bundleCode: r.code,
    op: r.op,
    round: r.round,
    pieces: r.pieces,
    mills: Number(r.mills),
  }));
}
