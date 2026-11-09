import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bundle, BundleStatus, PieceRate, Prisma, ScanInbox } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { CLOCK, Clock } from '../clock';
import type { HoodEvent } from '../hood/hood-event';
import { labourMills, rateAt } from '../line/rates';
import { canFlag, decide } from '../line/state-machine';
import { PrismaService } from '../prisma.service';
import { Rabbit } from '../rabbit';
import { markWaste } from './waste';

export type ApplyOutcome = 'applied' | 'duplicate' | 'held' | 'rejected' | 'skipped';

// Tests use beforeCommit to kill a delivery after every write but before the
// commit, which is where a crashed worker would leave things.
export type ApplyHooks = { beforeCommit(inboxId: string): Promise<void> | void };
export const APPLY_HOOKS = Symbol('APPLY_HOOKS');
export const noHooks = (): ApplyHooks => ({ beforeCommit: () => undefined });

type Tx = Prisma.TransactionClient;
type Verdict = { kind: 'apply' } | { kind: 'duplicate' } | { kind: 'hold' } | { kind: 'reject'; reason: string };
type Hood = { kind: HoodEvent['kind']; text: string; timed?: boolean };

// Everything one transaction knows about the locked bundle. state and done are
// kept current in memory as steps apply, so released held events are judged
// against the bundle as it is now, not as it was read.
type Work = {
  tx: Tx;
  bundle: Bundle;
  state: { status: BundleStatus; nextStep: number; route: string[]; reworkRound: number };
  done: { op: string; round: number }[];
  rates: PieceRate[];
  now: Date;
  hood: Hood[];
};

@Injectable()
export class ApplyService {
  private readonly log = new Logger(ApplyService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Rabbit) private readonly rabbit: Rabbit,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(APPLY_HOOKS) private readonly hooks: ApplyHooks,
  ) {}

  async apply(inboxId: string): Promise<ApplyOutcome> {
    const started = performance.now();
    let lockMs = 0;
    const hood: Hood[] = [];

    // Up to 50 deliveries can queue on one bundle's lock, so the defaults
    // (2 s for a connection, 5 s for the transaction) are too tight.
    const outcome = await this.prisma.$transaction(
      async (tx): Promise<ApplyOutcome> => {
        const first = await tx.scanInbox.findUnique({ where: { id: inboxId } });
        // Gone with a purged guest, or decided by an earlier delivery of the
        // same id: a double publish is harmless.
        if (!first || first.result !== null) return 'skipped';

        const askedAt = performance.now();
        // The lock is there because gate calls write the same bundle row from
        // the API at the same time, and so do other deliveries for this bundle
        // running in parallel under prefetch.
        const [bundle] = await tx.$queryRaw<Bundle[]>`
          SELECT * FROM "Bundle" WHERE "code" = ${first.bundleCode} FOR UPDATE`;
        lockMs = performance.now() - askedAt;
        if (!bundle) return 'skipped';

        // Read again under the lock: a second delivery of this id that was
        // waiting on the lock must see the result the first one committed.
        const row = await tx.scanInbox.findUniqueOrThrow({ where: { id: inboxId } });
        if (row.result !== null) return 'skipped';

        const style = await tx.style.findUniqueOrThrow({ where: { id: bundle.styleId } });
        const work: Work = {
          tx,
          bundle,
          state: {
            status: bundle.status,
            nextStep: bundle.nextStep,
            route: style.route,
            reworkRound: bundle.reworkRound,
          },
          done: await tx.bundleEvent.findMany({ where: { bundleId: bundle.id }, select: { op: true, round: true } }),
          rates: await tx.pieceRate.findMany({ where: { styleId: bundle.styleId } }),
          now: this.clock.now(),
          hood,
        };
        const result = await this.handle(work, row);
        await this.hooks.beforeCommit(inboxId);
        return result;
      },
      { maxWait: 10_000, timeout: 15_000 },
    );

    const txMs = performance.now() - started;
    void this.announce(hood, Math.round(lockMs), Math.round(txMs));
    return outcome;
  }

  private async handle(w: Work, row: ScanInbox): Promise<ApplyOutcome> {
    // A flag is not a route step, so decide has nothing to say about it.
    if (row.op === 'qc_flag' && !this.stale(w, row)) return this.flag(w, row);

    const v = this.judge(w, row);
    switch (v.kind) {
      case 'apply':
        await this.applyStep(w, row);
        w.hood.push({ kind: 'apply', text: `apply ${w.bundle.code} ${row.op}`, timed: true });
        await this.release(w);
        return 'applied';
      case 'duplicate':
        await this.settle(w, row, 'duplicate');
        return 'duplicate';
      case 'hold':
        await w.tx.heldEvent.create({ data: { inboxId: row.id, bundleId: w.bundle.id, heldAt: w.now } });
        await this.settle(w, row, 'held');
        w.hood.push({ kind: 'held', text: `held ${w.bundle.code} ${row.op}` });
        return 'held';
      case 'reject':
        await this.reject(w, row, v.reason);
        return 'rejected';
    }
  }

  private stale(w: Work, row: ScanInbox): boolean {
    return w.bundle.lastClearedAt !== null && row.correctedAt < w.bundle.lastClearedAt;
  }

  // A scan corrected to before the last rework clear belongs to the round
  // that ended; applying it would count old work against the new round.
  private judge(w: Work, row: ScanInbox): Verdict {
    if (this.stale(w, row)) return { kind: 'reject', reason: 'stale-round' };
    return decide(w.state, row.op, w.done);
  }

  private async applyStep(w: Work, row: ScanInbox): Promise<void> {
    const { tx, bundle, state } = w;
    const event = await tx.bundleEvent.create({
      data: {
        bundleId: bundle.id,
        op: row.op,
        source: 'batch',
        deviceId: row.deviceId,
        inboxId: row.id,
        round: state.reworkRound,
        correctedAt: row.correctedAt,
        isSimulated: await this.simulatedDevice(tx, row.deviceId, bundle),
        createdAt: w.now,
      },
    });
    w.done.push({ op: row.op, round: state.reworkRound });

    // qc_final, ship and the gate actions are not piece-rate work, and
    // rateAt throws for an op with no rate at all.
    if (w.rates.some((r) => r.op === row.op)) {
      const rate = rateAt(w.rates, bundle.styleId, row.op, row.correctedAt);
      const amountMills = labourMills(rate, bundle.pieces, await this.alreadyPaid(tx, bundle.code, row.op));
      if (amountMills > 0) {
        await tx.posting.create({
          data: {
            period: row.correctedAt.toISOString().slice(0, 7),
            kind: 'labour',
            amountMills,
            bundleCode: bundle.code,
            eventId: event.id,
            guestId: bundle.guestId,
            isSimulated: bundle.isSimulated,
            createdAt: w.now,
          },
        });
      }
    }

    state.nextStep += 1;
    if (row.op === 'pack') state.status = 'packed';
    if (row.op === 'ship') state.status = 'shipped';
    await tx.bundle.update({ where: { id: bundle.id }, data: { nextStep: state.nextStep, status: state.status } });
    await tx.scanInbox.update({ where: { id: row.id }, data: { result: 'applied', appliedAt: w.now } });
  }

  // Paid in any round counts: a step redone after rework is never paid twice.
  private async alreadyPaid(tx: Tx, bundleCode: string, op: string): Promise<boolean> {
    const rows = await tx.$queryRaw<unknown[]>`
      SELECT 1 FROM "Posting" p JOIN "BundleEvent" e ON e."id" = p."eventId"
      WHERE p."bundleCode" = ${bundleCode} AND p."kind" = 'labour' AND e."op" = ${op}
      LIMIT 1`;
    return rows.length > 0;
  }

  // Held rows are tried in corrected-time order until a pass frees none. A row
  // that is now a duplicate (two taps on the same step both held) is settled
  // rather than left to block the rest, and a step still waiting is skipped,
  // not treated as the end: clock skew can sort a later step first.
  private async release(w: Work): Promise<void> {
    for (let freed = true; freed; ) {
      freed = false;
      const held = await w.tx.$queryRaw<(ScanInbox & { heldId: string })[]>`
        SELECT h."id" AS "heldId", i.* FROM "HeldEvent" h JOIN "ScanInbox" i ON i."id" = h."inboxId"
        WHERE h."bundleId" = ${w.bundle.id}
        ORDER BY i."correctedAt", i."id"`;
      for (const row of held) {
        const v = this.judge(w, row);
        if (v.kind === 'hold') continue;
        await w.tx.heldEvent.delete({ where: { id: row.heldId } });
        freed = true;
        if (v.kind === 'apply') {
          await this.applyStep(w, row);
          w.hood.push({ kind: 'released', text: `released ${w.bundle.code} ${row.op}` });
        } else if (v.kind === 'duplicate') {
          await w.tx.scanInbox.update({ where: { id: row.id }, data: { result: 'duplicate' } });
        } else {
          await this.reject(w, row, v.reason);
        }
      }
    }
  }

  // All-async mode: the flag came in a batch, possibly after later steps were
  // already applied. Those steps were sewn on a bad bundle and are wasted.
  private async flag(w: Work, row: ScanInbox): Promise<ApplyOutcome> {
    const { tx, bundle, state } = w;
    if (!canFlag(state)) {
      await this.reject(w, row, 'cannot-flag');
      return 'rejected';
    }
    await tx.bundleEvent.create({
      data: {
        bundleId: bundle.id,
        op: 'qc_flag',
        source: 'batch',
        deviceId: row.deviceId,
        inboxId: row.id,
        round: state.reworkRound,
        correctedAt: row.correctedAt,
        isSimulated: await this.simulatedDevice(tx, row.deviceId, bundle),
        createdAt: w.now,
      },
    });
    // nextStep stays put: the supervisor's clear decides where the bundle restarts.
    state.status = 'rework';
    await tx.bundle.update({ where: { id: bundle.id }, data: { status: 'rework' } });

    const { wastedMills, deviceIds } = await markWaste(tx, bundle.id, row.correctedAt, state.reworkRound);
    if (deviceIds.length > 0) {
      const wasted = await tx.bundleEvent.findMany({
        where: {
          bundleId: bundle.id,
          round: state.reworkRound,
          wasted: true,
          correctedAt: { gt: row.correctedAt },
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
        await tx.deviceNotice.create({
          data: { deviceId, seq, bundleCode: bundle.code, result: 'wasted', createdAt: w.now },
        });
      }
    }
    await tx.scanInbox.update({ where: { id: row.id }, data: { result: 'applied', appliedAt: w.now } });
    w.hood.push({ kind: 'rework', text: `rework ${bundle.code} qc_flag · wasted ${wastedMills} mills` });
    return 'applied';
  }

  // The station learns of a late rejection on its next sync.
  private async reject(w: Work, row: ScanInbox, reason: string): Promise<void> {
    const result = `rejected(${reason})`;
    await w.tx.scanInbox.update({ where: { id: row.id }, data: { result } });
    await w.tx.deviceNotice.create({
      data: { deviceId: row.deviceId, seq: row.seq, bundleCode: row.bundleCode, result, createdAt: w.now },
    });
  }

  private async settle(w: Work, row: ScanInbox, result: string): Promise<void> {
    await w.tx.scanInbox.update({ where: { id: row.id }, data: { result } });
  }

  // The event records who did the work; the bundle may be a guest's while a
  // sim device sewed it.
  private async simulatedDevice(tx: Tx, deviceId: string, bundle: Bundle): Promise<boolean> {
    const device = await tx.device.findUnique({ where: { id: deviceId }, select: { isSimulated: true } });
    return device?.isSimulated ?? bundle.isSimulated;
  }

  // After commit only, and best effort: /hood is a window on the line, and a
  // lost line there must never undo or delay an applied scan.
  private async announce(hood: Hood[], lockMs: number, txMs: number): Promise<void> {
    for (const h of hood) {
      const text = h.timed ? `${h.text} · lock ${lockMs} ms · tx ${txMs} ms` : h.text;
      try {
        await this.rabbit.publishHood({ t: this.clock.now().getTime(), kind: h.kind, proc: 'worker', text });
      } catch (err) {
        this.log.warn(`hood publish dropped: ${(err as Error).message}`);
        return;
      }
    }
  }
}
