import { Prisma } from '@prisma/client';
import { rateAt } from '../line/rates';

type Tx = Prisma.TransactionClient;

// One implementation for both ways a flag arrives: through a batch here and at
// the Q-01 gate call. Anything done on the bundle after the flag's corrected
// time in the same round was work on a bad bundle, so it is wasted.
export async function markWaste(
  tx: Tx,
  bundleId: string,
  flagCorrectedAt: Date,
  round: number,
): Promise<{ wastedMills: number; deviceIds: string[] }> {
  const events = await tx.bundleEvent.findMany({
    where: { bundleId, round, wasted: false, correctedAt: { gt: flagCorrectedAt } },
  });
  if (events.length === 0) return { wastedMills: 0, deviceIds: [] };

  await tx.bundleEvent.updateMany({ where: { id: { in: events.map((e) => e.id) } }, data: { wasted: true } });

  const bundle = await tx.bundle.findUniqueOrThrow({ where: { id: bundleId } });
  const rates = await tx.pieceRate.findMany({ where: { styleId: bundle.styleId } });
  const trims = new Map((await tx.operation.findMany()).map((o) => [o.code, o.trimsMills]));
  let wastedMills = 0;
  for (const e of events) {
    // Each step is costed at the rate in force when it was done, not today's.
    const rated = rates.some((r) => r.op === e.op);
    const labour = rated ? rateAt(rates, bundle.styleId, e.op, e.correctedAt) * bundle.pieces : 0;
    wastedMills += labour + (trims.get(e.op) ?? 0);
  }
  const deviceIds = [...new Set(events.map((e) => e.deviceId).filter((d): d is string => d !== null))];
  return { wastedMills, deviceIds };
}
