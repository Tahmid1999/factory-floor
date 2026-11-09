import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Bundle, BundleEvent, BundleStatus, Device, Prisma } from '@prisma/client';
import { performance } from 'node:perf_hooks';
import { Hood, Tx, Work, applyStep, releaseHeld, workOn } from '../apply/steps';
import { markWaste, noticeWasted } from '../apply/waste';
import { audit } from '../audit/audit';
import { CLOCK, Clock } from '../clock';
import { GuestsService } from '../guests/guests.service';
import { Actor, mayScan } from '../guests/ownership';
import { StationCode } from '../line/line';
import { canFlag, decide, rollBackTo } from '../line/state-machine';
import { PrismaService } from '../prisma.service';
import { HoodService } from '../hood/hood';

export const GATE_ACTIONS = ['cut', 'qc_flag', 'qc_pass', 'qc_fail', 'ship', 'clear_rework', 'scrap'] as const;
export type GateAction = (typeof GATE_ACTIONS)[number];
export const DEFECTS = ['collar', 'sleeve', 'seam', 'hem', 'stain'] as const;
export type Defect = (typeof DEFECTS)[number];

export type GateBody = {
  deviceId: string;
  gateId: string;
  bundleCode?: string;
  action: GateAction;
  defect?: Defect;
  targetOp?: string;
};

export type GateReply = {
  ok: boolean;
  status: BundleStatus;
  nextOp: string | null;
  round: number;
  message: string;
  ms: number;
};

type Outcome = Omit<GateReply, 'ms'> & { eventId?: string };

// The station gives a gate call 2 s and then shows STOP. Waiting longer than
// this on a bundle the worker holds would apply a scan the operator was
// already told did not happen.
const LOCK_WAIT_MS = 1500;

const STATION_FOR: Record<GateAction, StationCode> = {
  cut: 'C-01',
  qc_flag: 'Q-01',
  qc_pass: 'Q-02',
  qc_fail: 'Q-02',
  ship: 'X-01',
  clear_rework: 'SUP',
  scrap: 'SUP',
};

// Where the operator walks the bundle back to. A stain is usually handling at
// the first sewing table, so it goes to the collar.
const SENT_BACK_TO: Record<Defect, StationCode> = {
  collar: 'S-07',
  sleeve: 'S-08',
  seam: 'S-09',
  hem: 'S-10',
  stain: 'S-07',
};

export function stationRefusal(station: string, action: GateAction): string | null {
  if (STATION_FOR[action] === station) return null;
  if (action === 'clear_rework' && (station === 'Q-01' || station === 'Q-02')) {
    return 'qc can flag rework but only a supervisor can clear it';
  }
  return `${station} cannot ${action}`;
}

@Injectable()
export class GateService {
  private readonly log = new Logger(GateService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(GuestsService) private readonly guests: GuestsService,
    @Inject(HoodService) private readonly hood: HoodService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // actorName is who the audit names: the visitor, or the sim device's name.
  async scan(actor: Actor, actorName: string, device: Device, body: GateBody): Promise<GateReply> {
    const started = performance.now();
    const now = this.clock.now();
    const hood: Hood[] = [];
    let reply: GateReply;
    try {
      reply = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_WAIT_MS}ms'`);
          const out =
            body.action === 'cut'
              ? await this.cut(tx, device, body, now, hood)
              : await this.onBundle(tx, actor, actorName, device, body, now, hood);
          if ('repeat' in out) return out.repeat;
          const { eventId, ...rest } = out;
          const r: GateReply = { ...rest, ms: Math.round(performance.now() - started) };
          if (eventId) await tx.bundleEvent.update({ where: { id: eventId }, data: { gateReply: r } });
          return r;
        },
        { maxWait: 2000, timeout: 5000 },
      );
    } catch (e) {
      // Two calls with the same gateId on different bundles, or two cuts,
      // do not share a lock; the unique index settles it and the loser
      // answers with the winner's reply.
      if (isUniqueGateId(e)) {
        const first = await this.repeatOf(this.prisma, body.gateId, device.id);
        if (first) return first;
      }
      if (isLockTimeout(e)) throw new HttpException({ error: 'bundle busy, scan again' }, 503);
      throw e;
    }
    this.announce(hood, reply.ms);
    return reply;
  }

  private async onBundle(
    tx: Tx,
    actor: Actor,
    actorName: string,
    device: Device,
    body: GateBody,
    now: Date,
    hood: Hood[],
  ): Promise<Outcome | { repeat: GateReply }> {
    // The same lock the worker takes, so a gate call and a batch apply on one
    // bundle run one after the other.
    const [bundle] = await tx.$queryRaw<Bundle[]>`
      SELECT * FROM "Bundle" WHERE "code" = ${body.bundleCode} FOR UPDATE`;
    // An unknown code gets the same answer as someone else's bundle.
    if (!bundle || !mayScan(actor, bundle, now)) throw new ForbiddenException({ error: 'not your bundle' });
    // Checked under the lock: a repeat that waited behind the first call must
    // see what the first one committed.
    const repeat = await this.repeatOf(tx, body.gateId, device.id);
    if (repeat) return { repeat };

    const w = await workOn(tx, bundle, now, hood);
    switch (body.action) {
      case 'qc_flag':
      case 'qc_fail':
        return this.flag(w, device, body);
      case 'qc_pass':
        return this.step(w, device, body, 'qc_final');
      case 'ship':
        return this.step(w, device, body, 'ship');
      case 'clear_rework':
        return this.clear(w, actorName, device, body);
      case 'scrap':
        return this.scrap(w, actorName, device, body);
      default:
        throw new BadRequestException({ error: 'bad gate scan' });
    }
  }

  // Inline QC (Q-01) and a failed final check (Q-02) both stop the bundle
  // here. nextStep stays put: the supervisor's clear decides where it restarts.
  private async flag(w: Work, device: Device, body: GateBody): Promise<Outcome> {
    const { tx, bundle, state } = w;
    const op = body.action as 'qc_flag' | 'qc_fail';
    if (op === 'qc_flag' && !canFlag(state)) {
      return this.refuse(w, state.status === 'active' ? `cannot be flagged at ${nextOpOf(w)}` : statusText(state.status));
    }
    if (op === 'qc_fail') {
      const why = this.notReady(w, 'qc_final');
      if (why) return this.refuse(w, why);
    }
    const event = await this.gateEvent(w, device, body, op);
    state.status = 'rework';
    await tx.bundle.update({ where: { id: bundle.id }, data: { status: 'rework' } });
    this.timed(w, device, op);

    const { wastedMills, deviceIds } = await markWaste(tx, bundle.id, w.now, state.reworkRound);
    await noticeWasted(tx, bundle, w.now, state.reworkRound, deviceIds, w.now);
    w.hood.push({ kind: 'rework', text: `rework ${bundle.code} ${op} · wasted ${wastedMills} mills` });
    return this.view(w, true, `${bundle.code} in rework · send back to ${SENT_BACK_TO[body.defect!]}`, event.id);
  }

  // qc_pass applies qc_final; ship applies ship. Both move nextStep, so what
  // was held behind them goes in the same transaction.
  private async step(w: Work, device: Device, body: GateBody, op: 'qc_final' | 'ship'): Promise<Outcome> {
    const why = this.notReady(w, op);
    if (why) return this.refuse(w, why);
    const event = await applyStep(w, {
      op,
      correctedAt: w.now,
      deviceId: device.id,
      source: 'gate',
      gateId: body.gateId,
    });
    this.timed(w, device, body.action);
    await releaseHeld(w);
    const code = w.bundle.code;
    return this.view(w, true, op === 'ship' ? `${code} shipped` : `${code} passed · next ${nextOpOf(w)}`, event.id);
  }

  private async clear(w: Work, actorName: string, device: Device, body: GateBody): Promise<Outcome> {
    const { tx, bundle, state } = w;
    const targetOp = body.targetOp!;
    if (!state.route.includes(targetOp)) throw new BadRequestException({ error: 'targetOp is not on the route' });
    if (state.status !== 'rework') return this.refuse(w, 'is not in rework');
    const to = rollBackTo(state.route, targetOp);
    // Only a step already done can have caused the defect, and cut is never
    // redone: cutting again makes a new bundle.
    if (to < state.route.indexOf('sew_collar') || to >= state.nextStep) {
      return this.refuse(w, `cannot go back to ${targetOp}`);
    }

    const before = snapshot(w);
    state.status = 'active';
    state.nextStep = to;
    state.reworkRound += 1;
    // releaseHeld below judges held rows against this: anything scanned before
    // the clear belongs to the round that just ended.
    w.bundle.lastClearedAt = w.now;
    await tx.bundle.update({
      where: { id: bundle.id },
      data: { status: 'active', nextStep: to, reworkRound: state.reworkRound, lastClearedAt: w.now },
    });
    // Recorded in the round it opens, like the redone steps that follow it.
    const event = await this.gateEvent(w, device, body, 'clear_rework');
    await audit(
      tx,
      {
        actor: actorName,
        role: 'supervisor',
        action: 'clear_rework',
        entity: `bundle:${bundle.code}`,
        before,
        after: snapshot(w),
      },
      this.clock,
    );
    this.timed(w, device, 'clear_rework');
    w.hood.push({ kind: 'clear', text: `clear ${bundle.code} → ${targetOp} · round ${state.reworkRound}` });
    await releaseHeld(w);
    return this.view(w, true, `${bundle.code} back to ${targetOp} · round ${state.reworkRound}`, event.id);
  }

  private async scrap(w: Work, actorName: string, device: Device, body: GateBody): Promise<Outcome> {
    const { tx, bundle, state } = w;
    if (state.status !== 'active' && state.status !== 'rework') return this.refuse(w, statusText(state.status));
    const before = snapshot(w);
    state.status = 'scrapped';
    await tx.bundle.update({ where: { id: bundle.id }, data: { status: 'scrapped' } });
    // Slice 1 stops at the status. The write-off posting (fabric plus labour
    // so far) needs the stock ledger and comes with it in slice 2.
    const event = await this.gateEvent(w, device, body, 'scrap');
    await audit(
      tx,
      { actor: actorName, role: 'supervisor', action: 'scrap', entity: `bundle:${bundle.code}`, before, after: snapshot(w) },
      this.clock,
    );
    this.timed(w, device, 'scrap');
    // Held rows behind a scrapped bundle can never apply; reject them now so
    // their stations hear it instead of the rows showing as stuck tomorrow.
    await releaseHeld(w);
    return this.view(w, true, `${bundle.code} scrapped`, event.id);
  }

  // Sim cutting makes a new bundle, so there is no row to lock and the gateId
  // index alone guards a repeat.
  private async cut(
    tx: Tx,
    device: Device,
    body: GateBody,
    now: Date,
    hood: Hood[],
  ): Promise<Outcome | { repeat: GateReply }> {
    const repeat = await this.repeatOf(tx, body.gateId, device.id);
    if (repeat) return { repeat };
    const [{ bundle, event }] = await this.guests.cutBundles(tx, {
      count: 1,
      guestId: null,
      cutter: device,
      now,
      gateId: body.gateId,
    });
    const w = await workOn(tx, bundle, now, hood);
    this.timed(w, device, 'cut');
    return this.view(w, true, `cut ${bundle.code}`, event.id);
  }

  private async repeatOf(tx: Tx, gateId: string, deviceId: string): Promise<GateReply | null> {
    const e = await tx.bundleEvent.findUnique({ where: { gateId }, select: { deviceId: true, gateReply: true } });
    if (!e) return null;
    // A gateId is the station's own; another device reusing one is a bug or a
    // probe, and either way it does not get someone else's answer.
    if (e.deviceId !== deviceId || e.gateReply === null) throw new ConflictException({ error: 'gateId already used' });
    return e.gateReply as GateReply;
  }

  private gateEvent(w: Work, device: Device, body: GateBody, op: string): Promise<BundleEvent> {
    return w.tx.bundleEvent.create({
      data: {
        bundleId: w.bundle.id,
        op,
        source: 'gate',
        deviceId: device.id,
        gateId: body.gateId,
        round: w.state.reworkRound,
        correctedAt: w.now,
        isSimulated: device.isSimulated,
        createdAt: w.now,
      },
    });
  }

  // Why op cannot be applied now, in words for the station, or null.
  private notReady(w: Work, op: string): string | null {
    if (decide(w.state, op, w.done).kind === 'apply') return null;
    if (w.state.status !== 'active' && w.state.status !== 'packed') return statusText(w.state.status);
    return `is at ${nextOpOf(w) ?? 'the end'}, not ${op}`;
  }

  // A refusal writes nothing, so a repeat of the same gateId is judged again.
  private refuse(w: Work, why: string): Outcome {
    return this.view(w, false, `${w.bundle.code} ${why}`);
  }

  private view(w: Work, ok: boolean, message: string, eventId?: string): Outcome {
    return { ok, status: w.state.status, nextOp: nextOpOf(w), round: w.state.reworkRound, message, eventId };
  }

  private timed(w: Work, device: Device, action: string): void {
    w.hood.push({ kind: 'gate', text: `gate ${device.code} ${w.bundle.code} ${action}`, timed: true });
  }

  // After commit only. The hood keeps the line in memory first, so a broker
  // that is down cannot lose it or undo the scan.
  private announce(hood: Hood[], ms: number): void {
    for (const h of hood) this.hood.emit(h.kind, h.timed ? `${h.text} · ${ms} ms` : h.text);
  }
}

function nextOpOf(w: Work): string | null {
  return w.state.status === 'scrapped' ? null : (w.state.route[w.state.nextStep] ?? null);
}

function statusText(status: BundleStatus): string {
  return status === 'rework' ? 'is in rework' : `is ${status}`;
}

// The step by name, not index, so the audit reads without knowing the route.
function snapshot(w: Work) {
  return { status: w.state.status, nextStep: w.state.route[w.state.nextStep] ?? null, round: w.state.reworkRound };
}

function isUniqueGateId(e: unknown): boolean {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return false;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.includes('gateId') : String(target).includes('gateId');
}

// Postgres 55P03 is lock_not_available, raised when lock_timeout runs out.
function isLockTimeout(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && (e.meta as { code?: string } | undefined)?.code === '55P03';
}
