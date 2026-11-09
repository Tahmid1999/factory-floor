import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '../clock';
import { Actor, mayScan } from '../guests/ownership';
import { POLO_ROUTE } from '../line/line';
import { PrismaService } from '../prisma.service';
import { Rabbit } from '../rabbit';

export type BatchEvent = { seq: number; bundleCode: string; op: string; scannedAt: number; offsetMs: number };
export type BatchBody = { deviceId: string; deviceNow: number; events: BatchEvent[] };

type Verdict = { seq: number; result: 'accepted' | 'duplicate' | 'rejected'; reason?: string };
type Resync = { bundleCode: string; status: string; nextOp: string | null; round: number };
export type BatchReply = {
  serverNow: number;
  results: Verdict[];
  resync: Resync[];
  notices: { seq: number; bundleCode: string; result: string }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = 60 * 1000;
const INT32_MAX = 2 ** 31 - 1;

// These are decided at a gate call, which answers at once; queueing them would
// let a stale scan ship or pass a bundle. clear_rework and scrap are gate
// actions too, so a batch may not carry them either.
const GATE_ONLY = new Set(['cut', 'qc_final', 'ship', 'clear_rework', 'scrap']);

@Injectable()
export class IngestService {
  private readonly log = new Logger(IngestService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(Rabbit) private readonly rabbit: Rabbit,
  ) {}

  // A guest owns its own devices and the sim owns the simulated ones. The same
  // 403 covers a missing device so ids cannot be probed.
  async deviceFor(actor: Actor, deviceId: string): Promise<Device> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const mine =
      device && (actor.sim ? device.isSimulated : actor.guestId !== undefined && device.guestId === actor.guestId);
    if (!device || !mine) throw new ForbiddenException({ error: 'not your device' });
    return device;
  }

  async ingest(actor: Actor, device: Device, body: BatchBody): Promise<BatchReply> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const acceptedIds: string[] = [];

    const reply = await this.prisma.$transaction(async (tx): Promise<BatchReply> => {
      const codes = [...new Set(body.events.map((e) => e.bundleCode))];
      const bundles = new Map((await tx.bundle.findMany({ where: { code: { in: codes } } })).map((b) => [b.code, b]));
      const resync = new Map<string, Resync>();
      const results: Verdict[] = [];

      for (const e of body.events) {
        const correctedAt = e.scannedAt + e.offsetMs;
        const reject = (reason: string) => results.push({ seq: e.seq, result: 'rejected', reason });

        if (
          correctedAt < nowMs - DAY_MS ||
          correctedAt > nowMs + FUTURE_SLACK_MS ||
          correctedAt < device.registeredAt.getTime()
        ) {
          reject('clock');
          continue;
        }
        // An unknown code gets the same answer as someone else's bundle so the
        // reply does not say which codes exist.
        const bundle = bundles.get(e.bundleCode);
        if (!bundle || !mayScan(actor, bundle, now)) {
          reject('not-yours');
          continue;
        }
        if (GATE_ONLY.has(e.op)) {
          reject('gate-only');
          continue;
        }

        const id = randomUUID();
        const inserted = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
          INSERT INTO "ScanInbox" ("id", "deviceId", "seq", "bundleCode", "op", "scannedAt", "offsetMs", "correctedAt", "receivedAt")
          VALUES (${id}, ${device.id}, ${e.seq}, ${e.bundleCode}, ${e.op}, ${new Date(e.scannedAt)}, ${e.offsetMs}, ${new Date(correctedAt)}, ${now})
          ON CONFLICT ("deviceId", "seq") DO NOTHING
          RETURNING "id"`);
        if (inserted.length === 0) {
          results.push({ seq: e.seq, result: 'duplicate' });
          continue;
        }

        // No lock: a bundle that goes to rework a moment later is caught by the
        // worker, which checks again under its own lock.
        if (bundle.status === 'rework' || bundle.status === 'scrapped') {
          await tx.scanInbox.update({ where: { id }, data: { result: 'rejected(rework)' } });
          resync.set(bundle.code, resyncOf(bundle));
          results.push({ seq: e.seq, result: 'rejected', reason: 'rework' });
        } else {
          acceptedIds.push(id);
          results.push({ seq: e.seq, result: 'accepted' });
        }
      }

      // One statement both selects and marks them, so two batches racing each
      // other cannot deliver the same notice twice.
      const notices = await tx.$queryRaw<{ seq: number; bundleCode: string; result: string }[]>(Prisma.sql`
        UPDATE "DeviceNotice" SET "deliveredAt" = ${now}
        WHERE "deviceId" = ${device.id} AND "deliveredAt" IS NULL
        RETURNING "seq", "bundleCode", "result"`);
      const missing = [...new Set(notices.map((n) => n.bundleCode))].filter((c) => !resync.has(c));
      if (missing.length > 0) {
        for (const b of await tx.bundle.findMany({ where: { code: { in: missing } } })) {
          resync.set(b.code, resyncOf(b));
        }
      }

      // The offset is only a hint for the next batch; clamp it so a wild
      // deviceNow cannot overflow the column.
      const offset = Math.max(-INT32_MAX, Math.min(INT32_MAX, Math.round(nowMs - body.deviceNow)));
      await tx.device.update({
        where: { id: device.id },
        data: { lastSyncAt: now, lastPending: body.events.length, clockOffsetMs: offset },
      });

      return { serverNow: nowMs, results, resync: [...resync.values()], notices };
    });

    // write first, publish after, sweep what didn't get applied
    for (const id of acceptedIds) {
      try {
        await this.rabbit.publishApply(id);
      } catch (err) {
        // The broker is likely down for the rest as well; the sweep covers them.
        this.log.error(
          `publish failed, leaving ${acceptedIds.length} inbox row(s) to the sweep: ${(err as Error).message}`,
        );
        break;
      }
    }
    return reply;
  }
}

function resyncOf(b: { code: string; status: string; nextStep: number; reworkRound: number }): Resync {
  return {
    bundleCode: b.code,
    status: b.status,
    nextOp: b.status === 'scrapped' ? null : (POLO_ROUTE[b.nextStep] ?? null),
    round: b.reworkRound,
  };
}
