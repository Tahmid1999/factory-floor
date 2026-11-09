import { Bundle, BundleEvent, BundleStatus, EventSource, PieceRate, Prisma, ScanInbox } from '@prisma/client';
import type { HoodEvent } from '../hood/hood-event';
import { labourMills, rateAt } from '../line/rates';
import { Decision, decide } from '../line/state-machine';

// Shared by the worker and the gate: both lock the same bundle row and must
// apply a step, pay it and free what was held behind it the same way.

export type Tx = Prisma.TransactionClient;
export type Hood = { kind: HoodEvent['kind']; text: string; timed?: boolean };
export type Verdict = Decision | { kind: 'reject'; reason: 'stale-round' };

// Everything one transaction knows about the locked bundle. state and done are
// kept current in memory as steps apply, so released held events are judged
// against the bundle as it is now, not as it was read.
export type Work = {
  tx: Tx;
  bundle: Bundle;
  state: { status: BundleStatus; nextStep: number; route: string[]; reworkRound: number };
  done: { op: string; round: number }[];
  rates: PieceRate[];
  now: Date;
  hood: Hood[];
};

// One step done on the bundle: a batch scan carries its inbox id, a gate call
// its gate id.
export type Step = {
  op: string;
  correctedAt: Date;
  deviceId: string;
  source: EventSource;
  inboxId?: string;
  gateId?: string;
};

// Call with the bundle already locked FOR UPDATE.
export async function workOn(tx: Tx, bundle: Bundle, now: Date, hood: Hood[]): Promise<Work> {
  const style = await tx.style.findUniqueOrThrow({ where: { id: bundle.styleId } });
  return {
    tx,
    bundle,
    state: { status: bundle.status, nextStep: bundle.nextStep, route: style.route, reworkRound: bundle.reworkRound },
    done: await tx.bundleEvent.findMany({ where: { bundleId: bundle.id }, select: { op: true, round: true } }),
    rates: await tx.pieceRate.findMany({ where: { styleId: bundle.styleId } }),
    now,
    hood,
  };
}

export function isStale(w: Work, correctedAt: Date): boolean {
  return w.bundle.lastClearedAt !== null && correctedAt < w.bundle.lastClearedAt;
}

// A scan corrected to before the last rework clear belongs to the round
// that ended; applying it would count old work against the new round.
export function judge(w: Work, row: { op: string; correctedAt: Date }): Verdict {
  if (isStale(w, row.correctedAt)) return { kind: 'reject', reason: 'stale-round' };
  return decide(w.state, row.op, w.done);
}

export async function applyStep(w: Work, s: Step): Promise<BundleEvent> {
  const { tx, bundle, state } = w;
  const isSimulated = await simulatedDevice(tx, s.deviceId, bundle);
  const event = await tx.bundleEvent.create({
    data: {
      bundleId: bundle.id,
      op: s.op,
      source: s.source,
      deviceId: s.deviceId,
      inboxId: s.inboxId,
      gateId: s.gateId,
      round: state.reworkRound,
      correctedAt: s.correctedAt,
      isSimulated,
      createdAt: w.now,
    },
  });
  w.done.push({ op: s.op, round: state.reworkRound });

  // qc_final, ship and the gate actions are not piece-rate work, and
  // rateAt throws for an op with no rate at all.
  if (w.rates.some((r) => r.op === s.op)) {
    const rate = rateAt(w.rates, bundle.styleId, s.op, s.correctedAt);
    const amountMills = labourMills(rate, bundle.pieces, await alreadyPaid(tx, bundle.code, s.op));
    if (amountMills > 0) {
      await tx.posting.create({
        data: {
          period: s.correctedAt.toISOString().slice(0, 7),
          kind: 'labour',
          amountMills,
          bundleCode: bundle.code,
          eventId: event.id,
          guestId: bundle.guestId,
          // Follows whoever did the work, so "exclude simulated" in the
          // P&L leaves exactly the visitor's own scans.
          isSimulated,
          createdAt: w.now,
        },
      });
    }
  }

  state.nextStep += 1;
  if (s.op === 'pack') state.status = 'packed';
  if (s.op === 'ship') state.status = 'shipped';
  await tx.bundle.update({ where: { id: bundle.id }, data: { nextStep: state.nextStep, status: state.status } });
  if (s.inboxId) await tx.scanInbox.update({ where: { id: s.inboxId }, data: { result: 'applied', appliedAt: w.now } });
  return event;
}

export function stepOf(row: ScanInbox): Step {
  return { op: row.op, correctedAt: row.correctedAt, deviceId: row.deviceId, source: 'batch', inboxId: row.id };
}

// Paid in any round counts: a step redone after rework is never paid twice.
async function alreadyPaid(tx: Tx, bundleCode: string, op: string): Promise<boolean> {
  const rows = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM "Posting" p JOIN "BundleEvent" e ON e."id" = p."eventId"
    WHERE p."bundleCode" = ${bundleCode} AND p."kind" = 'labour' AND e."op" = ${op}
    LIMIT 1`;
  return rows.length > 0;
}

// Held rows are tried in corrected-time order until a pass frees none. A row
// that is now a duplicate (two taps on the same step both held) is settled
// rather than left to block the rest, and a step still waiting is skipped,
// not treated as the end: clock skew can sort a later step first. Anything
// that moves nextStep or the round must call this before it commits, or a
// step held behind it waits forever.
export async function releaseHeld(w: Work): Promise<void> {
  for (let freed = true; freed; ) {
    freed = false;
    const held = await w.tx.$queryRaw<(ScanInbox & { heldId: string })[]>`
      SELECT h."id" AS "heldId", i.* FROM "HeldEvent" h JOIN "ScanInbox" i ON i."id" = h."inboxId"
      WHERE h."bundleId" = ${w.bundle.id}
      ORDER BY i."correctedAt", i."id"`;
    for (const row of held) {
      const v = judge(w, row);
      if (v.kind === 'hold') continue;
      await w.tx.heldEvent.delete({ where: { id: row.heldId } });
      freed = true;
      if (v.kind === 'apply') {
        await applyStep(w, stepOf(row));
        w.hood.push({ kind: 'released', text: `released ${w.bundle.code} ${row.op}` });
      } else if (v.kind === 'duplicate') {
        await w.tx.scanInbox.update({ where: { id: row.id }, data: { result: 'duplicate' } });
      } else {
        await rejectRow(w, row, v.reason);
      }
    }
  }
}

// The station learns of a late rejection on its next sync.
export async function rejectRow(w: Work, row: ScanInbox, reason: string): Promise<void> {
  const result = `rejected(${reason})`;
  await w.tx.scanInbox.update({ where: { id: row.id }, data: { result } });
  await w.tx.deviceNotice.create({
    data: { deviceId: row.deviceId, seq: row.seq, bundleCode: row.bundleCode, result, createdAt: w.now },
  });
}

// The event records who did the work; the bundle may be a guest's while a
// sim device sewed it.
export async function simulatedDevice(tx: Tx, deviceId: string, bundle: Bundle): Promise<boolean> {
  const device = await tx.device.findUnique({ where: { id: deviceId }, select: { isSimulated: true } });
  return device?.isSimulated ?? bundle.isSimulated;
}
