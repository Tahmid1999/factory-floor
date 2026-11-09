import { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

// Waste is money already spent on a bad bundle: the labour actually posted for
// each event (nothing for a redo, which is never paid twice) plus the op's
// trims, which were used up whether or not the step was paid. Rate times
// pieces would count an unpaid redo as if it had cost its wage again.
async function priceOf(tx: Tx, events: { id: string; op: string }[]): Promise<number> {
  if (events.length === 0) return 0;
  const paid = await tx.posting.aggregate({
    where: { eventId: { in: events.map((e) => e.id) }, kind: 'labour' },
    _sum: { amountMills: true },
  });
  const trims = new Map((await tx.operation.findMany()).map((o) => [o.code, o.trimsMills]));
  return (paid._sum.amountMills ?? 0) + events.reduce((sum, e) => sum + (trims.get(e.op) ?? 0), 0);
}

// What /me shows per bundle; the same pricing markWaste reports.
export async function wasteOf(tx: Tx, bundleId: string): Promise<number> {
  const events = await tx.bundleEvent.findMany({ where: { bundleId, wasted: true }, select: { id: true, op: true } });
  return priceOf(tx, events);
}

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
  const wastedMills = await priceOf(tx, events);
  const deviceIds = [...new Set(events.map((e) => e.deviceId).filter((d): d is string => d !== null))];
  return { wastedMills, deviceIds };
}

// Each device whose work was wasted hears it on its next sync, against the seq
// of its first wasted scan so the station can mark that row.
export async function noticeWasted(
  tx: Tx,
  bundle: { id: string; code: string },
  flagCorrectedAt: Date,
  round: number,
  deviceIds: string[],
  now: Date,
): Promise<void> {
  if (deviceIds.length === 0) return;
  const wasted = await tx.bundleEvent.findMany({
    where: {
      bundleId: bundle.id,
      round,
      wasted: true,
      correctedAt: { gt: flagCorrectedAt },
      deviceId: { in: deviceIds },
    },
    orderBy: { correctedAt: 'asc' },
    select: { deviceId: true, inboxId: true },
  });
  const inboxIds = wasted.map((e) => e.inboxId).filter((id): id is string => id !== null);
  const seqs = new Map(
    (await tx.scanInbox.findMany({ where: { id: { in: inboxIds } }, select: { id: true, seq: true } })).map((r) => [
      r.id,
      r.seq,
    ]),
  );
  for (const deviceId of deviceIds) {
    const e = wasted.find((x) => x.deviceId === deviceId);
    // A gate event has no inbox row and so no seq the station would know.
    const seq = e?.inboxId ? (seqs.get(e.inboxId) ?? 0) : 0;
    await tx.deviceNotice.create({ data: { deviceId, seq, bundleCode: bundle.code, result: 'wasted', createdAt: now } });
  }
}
