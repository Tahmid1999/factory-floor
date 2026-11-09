import { Inject, Injectable, Logger } from '@nestjs/common';
import { Bundle, ScanInbox } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { CLOCK, Clock } from '../clock';
import { canFlag } from '../line/state-machine';
import { PrismaService } from '../prisma.service';
import { Rabbit } from '../rabbit';
import { Hood, Work, applyStep, isStale, judge, rejectRow, releaseHeld, simulatedDevice, stepOf, workOn } from './steps';
import { markWaste, noticeWasted } from './waste';

export type ApplyOutcome = 'applied' | 'duplicate' | 'held' | 'rejected' | 'skipped';

// Tests use beforeCommit to kill a delivery after every write but before the
// commit, which is where a crashed worker would leave things.
export type ApplyHooks = { beforeCommit(inboxId: string): Promise<void> | void };
export const APPLY_HOOKS = Symbol('APPLY_HOOKS');
export const noHooks = (): ApplyHooks => ({ beforeCommit: () => undefined });

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

        const work = await workOn(tx, bundle, this.clock.now(), hood);
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
    if (row.op === 'qc_flag' && !isStale(w, row.correctedAt)) return this.flag(w, row);

    const v = judge(w, row);
    switch (v.kind) {
      case 'apply':
        await applyStep(w, stepOf(row));
        w.hood.push({ kind: 'apply', text: `apply ${w.bundle.code} ${row.op}`, timed: true });
        await releaseHeld(w);
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
        await rejectRow(w, row, v.reason);
        return 'rejected';
    }
  }

  // All-async mode: the flag came in a batch, possibly after later steps were
  // already applied. Those steps were sewn on a bad bundle and are wasted.
  private async flag(w: Work, row: ScanInbox): Promise<ApplyOutcome> {
    const { tx, bundle, state } = w;
    if (!canFlag(state)) {
      await rejectRow(w, row, 'cannot-flag');
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
        isSimulated: await simulatedDevice(tx, row.deviceId, bundle),
        createdAt: w.now,
      },
    });
    // nextStep stays put: the supervisor's clear decides where the bundle restarts.
    state.status = 'rework';
    await tx.bundle.update({ where: { id: bundle.id }, data: { status: 'rework' } });

    const { wastedMills, deviceIds } = await markWaste(tx, bundle.id, row.correctedAt, state.reworkRound);
    await noticeWasted(tx, bundle, row.correctedAt, state.reworkRound, deviceIds, w.now);
    await tx.scanInbox.update({ where: { id: row.id }, data: { result: 'applied', appliedAt: w.now } });
    w.hood.push({ kind: 'rework', text: `rework ${bundle.code} qc_flag · wasted ${wastedMills} mills` });
    return 'applied';
  }

  private async settle(w: Work, row: ScanInbox, result: string): Promise<void> {
    await w.tx.scanInbox.update({ where: { id: row.id }, data: { result } });
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
