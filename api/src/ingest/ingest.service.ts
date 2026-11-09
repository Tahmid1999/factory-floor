import { ForbiddenException, Inject, Injectable, Logger } from '@nestjs/common';
import { Device, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { CLOCK, Clock } from '../clock';
import { Actor, mayScan } from '../guests/ownership';
import { POLO_ROUTE, STATIONS, StationCode } from '../line/line';
import { PrismaService } from '../prisma.service';
import { deviceLabel, HoodService } from '../hood/hood';
import { Rabbit } from '../rabbit';

export type BatchEvent = { seq: number; bundleCode: string; op: string; scannedAt: number; offsetMs: number };
export type BatchBody = { deviceId: string; deviceNow: number; events: BatchEvent[] };

type Verdict = { seq: number; result: 'accepted' | 'duplicate' | 'rejected'; reason?: string };
type Resync = { bundleCode: string; status: string; nextOp: string | null; round: number };
export type BatchReply = {
  serverNow: number;
  results: Verdict[];
  resync: Resync[];
  notices: { id: string; seq: number; bundleCode: string; result: string }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;
const FUTURE_SLACK_MS = 60 * 1000;
const NOTICE_REPEAT_MS = 60 * 1000;
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
    @Inject(HoodService) private readonly hood: HoodService,
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
    const started = performance.now();
    const now = this.clock.now();
    const nowMs = now.getTime();
    const acceptedIds: string[] = [];

    const reply = await this.prisma.$transaction(async (tx): Promise<BatchReply> => {
      const codes = [...new Set(body.events.map((e) => e.bundleCode))];
      const bundles = new Map(
        (await tx.bundle.findMany({ where: { code: { in: codes } }, include: { guest: { select: { lastActiveAt: true } } } })).map(
          (b) => [b.code, b],
        ),
      );
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
        // A device is one station on the floor and scans that station's op
        // only. Without this a visitor's S-07 could post the pack that P-01,
        // a sim-only station, is there to make, or a hem it never stood at.
        if (STATIONS[device.code as StationCode]?.op !== e.op) {
          reject('wrong-station');
          continue;
        }
        // An unknown code gets the same answer as someone else's bundle so the
        // reply does not say which codes exist.
        const bundle = bundles.get(e.bundleCode);
        if (!bundle || !mayScan(actor, { ...bundle, guestLastActiveAt: bundle.guest?.lastActiveAt ?? null }, now)) {
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
          // A resend after a lost reply must get the same answer as the first
          // time, or the station never learns the scan was rejected.
          const first = await tx.scanInbox.findUnique({
            where: { deviceId_seq: { deviceId: device.id, seq: e.seq } },
            select: { result: true },
          });
          const rejected = first?.result?.match(/^rejected\((.+)\)$/);
          if (rejected) {
            resync.set(bundle.code, resyncOf(bundle));
            results.push({ seq: e.seq, result: 'rejected', reason: rejected[1] });
          } else {
            results.push({ seq: e.seq, result: 'duplicate' });
          }
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

      // A reply can be lost after commit, so a notice is repeated for a
      // minute and the station ignores ids it has already shown. Only the
      // undelivered ones are stamped; the update runs first so they are
      // returned by the read below, and two racing batches cannot both stamp.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "DeviceNotice" SET "deliveredAt" = ${now}
        WHERE "deviceId" = ${device.id} AND "deliveredAt" IS NULL`);
      const notices = await tx.$queryRaw<{ id: string; seq: number; bundleCode: string; result: string }[]>(Prisma.sql`
        SELECT "id", "seq", "bundleCode", "result" FROM "DeviceNotice"
        WHERE "deviceId" = ${device.id} AND "deliveredAt" >= ${new Date(nowMs - NOTICE_REPEAT_MS)}
        ORDER BY "createdAt", "seq"`);
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
    this.announce(device, body, reply, started);
    return reply;
  }

  // A heartbeat with nothing in it is not worth a line. The reason is named
  // only when every rejection shares it, so the line stays one short phrase.
  private announce(device: Device, body: BatchBody, reply: BatchReply, started: number): void {
    if (body.events.length === 0) return;
    const seqs = body.events.map((e) => e.seq);
    const rejected = reply.results.filter((r) => r.result === 'rejected');
    const reasons = new Set(rejected.map((r) => r.reason));
    const why = reasons.size === 1 ? ` (${[...reasons][0]})` : '';
    const ms = Math.round(performance.now() - started);
    this.hood.emit(
      'batch',
      `batch ${deviceLabel(device)} seq ${Math.min(...seqs)}-${Math.max(...seqs)} · ${seqs.length} in · ${rejected.length} rejected${why} · ${ms} ms`,
    );
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
