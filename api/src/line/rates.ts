import { PieceRate } from '@prisma/client';

export function rateAt(rates: PieceRate[], styleId: string, op: string, at: Date): number {
  let best: PieceRate | undefined;
  for (const r of rates) {
    if (r.styleId !== styleId || r.op !== op || r.effectiveFrom > at) continue;
    if (!best || r.effectiveFrom > best.effectiveFrom) best = r;
  }
  if (!best) throw new Error(`no rate for ${op} on style ${styleId} at ${at.toISOString()}`);
  return best.ratePerPieceMills;
}

// A step done again after rework is never paid twice: if rework were paid,
// operators would fail QC on purpose to double their wages.
export function labourMills(rate: number, pieces: number, alreadyPaid: boolean): number {
  return alreadyPaid ? 0 : rate * pieces;
}
