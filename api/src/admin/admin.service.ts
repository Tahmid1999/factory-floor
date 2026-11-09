import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PieceRate, Prisma } from '@prisma/client';
import { wasteOf } from '../apply/waste';
import { audit } from '../audit/audit';
import { CLOCK, Clock } from '../clock';
import { deviceLabel, HoodService } from '../hood/hood';
import { POLO_ROUTE, STYLE_CODE } from '../line/line';
import { PrismaService } from '../prisma.service';
import { deleteGuestData } from '../purge/guest-data';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_RATE_MILLS = 1_000_000;

type Who = { login: string; role: string };

const deviceKind = (d: { isSimulated: boolean }) => (d.isSimulated ? 'sim' : 'guest');

// The rate for an op at an instant, or null when none had started yet.
function rateIn(rates: PieceRate[], at: Date): PieceRate | null {
  let best: PieceRate | null = null;
  for (const r of rates) if (r.effectiveFrom <= at && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best;
}

// A scrapped bundle goes nowhere; a shipped one has walked off the route.
function nextOpOf(b: { status: string; nextStep: number }): string | null {
  return b.status === 'scrapped' ? null : (POLO_ROUTE[b.nextStep] ?? null);
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HoodService) private readonly hood: HoodService,
  ) {}

  async floor() {
    const now = this.clock.now();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const style = await this.prisma.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    const [rates, operations, waiting, done, visitors] = await Promise.all([
      this.prisma.pieceRate.findMany({ where: { styleId: style.id } }),
      this.prisma.operation.findMany(),
      this.prisma.bundle.groupBy({ by: ['nextStep'], where: { status: 'active' }, _count: true }),
      this.prisma.bundleEvent.groupBy({ by: ['op'], where: { correctedAt: { gte: midnight } }, _count: true }),
      this.prisma.guest.count({ where: { lastActiveAt: { gte: new Date(now.getTime() - ACTIVE_MS) } } }),
    ]);
    const ops = style.route.map((op, step) => ({
      op,
      waiting: waiting.find((w) => w.nextStep === step)?._count ?? 0,
      doneToday: done.find((d) => d.op === op)?._count ?? 0,
      rateMills:
        rateIn(
          rates.filter((r) => r.op === op),
          now,
        )?.ratePerPieceMills ?? 0,
      gate: operations.find((o) => o.code === op)?.isGate ?? false,
    }));
    return {
      ops,
      simOn: process.env.SIM_ENABLED !== '0',
      visitors,
      tail: this.hood.tail(['batch', 'gate', 'apply'], 10),
    };
  }

  async bundles(q?: string) {
    const rows = await this.prisma.bundle.findMany({
      where: q ? { code: { startsWith: q } } : undefined,
      orderBy: [{ createdAt: 'desc' }, { code: 'desc' }],
      take: 50,
      include: { guest: { select: { name: true } } },
    });
    return Promise.all(
      rows.map(async (b) => ({
        code: b.code,
        status: b.status,
        nextOp: nextOpOf(b),
        round: b.reworkRound,
        owner: b.guest?.name ?? 'sim',
        wastedMills: await wasteOf(this.prisma, b.id),
      })),
    );
  }

  // Every scan that reached the server for this bundle, applied or not: the
  // inbox holds the rejected and held ones, which never became events. Gate
  // calls have no inbox row, so they come from the events.
  async bundle(code: string) {
    const b = await this.prisma.bundle.findUnique({ where: { code }, include: { guest: { select: { name: true } } } });
    if (!b) throw new NotFoundException({ error: 'no such bundle' });

    const [inbox, events, held] = await Promise.all([
      this.prisma.scanInbox.findMany({ where: { bundleCode: code } }),
      this.prisma.bundleEvent.findMany({ where: { bundleId: b.id } }),
      this.prisma.heldEvent.findMany({ where: { bundleId: b.id }, select: { inboxId: true } }),
    ]);
    const deviceIds = [
      ...new Set([...inbox.map((r) => r.deviceId), ...events.flatMap((e) => (e.deviceId ? [e.deviceId] : []))]),
    ];
    const devices = new Map(
      (await this.prisma.device.findMany({ where: { id: { in: deviceIds } } })).map((d) => [d.id, d]),
    );
    const postings = await this.prisma.posting.groupBy({
      by: ['eventId'],
      where: { eventId: { in: events.map((e) => e.id) }, kind: 'labour' },
      _sum: { amountMills: true },
    });
    const posted = new Map(postings.map((p) => [p.eventId, p._sum.amountMills ?? 0]));
    const heldNow = new Set(held.map((h) => h.inboxId));
    const eventOfInbox = new Map(events.filter((e) => e.inboxId).map((e) => [e.inboxId, e]));

    const who = (deviceId: string | null) => {
      const d = deviceId ? devices.get(deviceId) : undefined;
      return d ? { device: deviceLabel(d), deviceKind: deviceKind(d) } : { device: null, deviceKind: null };
    };
    const outcome = (e: (typeof events)[number] | undefined) => ({
      wasted: e?.wasted ?? false,
      round: e?.round ?? null,
      postedMills: e ? (posted.get(e.id) ?? 0) : 0,
    });

    const fromInbox = inbox.map((r) => ({
      source: 'batch' as const,
      op: r.op,
      seq: r.seq as number | null,
      ...who(r.deviceId),
      scannedAt: r.scannedAt.getTime() as number | null,
      correctedAt: r.correctedAt.getTime(),
      receivedAt: r.receivedAt.getTime(),
      result: r.result ?? 'pending',
      held: heldNow.has(r.id),
      // heldAt stays after release, which deletes the HeldEvent.
      released: r.heldAt !== null && !heldNow.has(r.id) && r.result === 'applied',
      heldAt: r.heldAt?.getTime() ?? null,
      ...outcome(eventOfInbox.get(r.id)),
    }));
    // A batch event whose inbox row the 60-day clean-up dropped still counts.
    const known = new Set(inbox.map((r) => r.id));
    const fromEvents = events
      .filter((e) => e.source === 'gate' || (e.inboxId && !known.has(e.inboxId)))
      .map((e) => ({
        source: e.source,
        op: e.op,
        seq: null as number | null,
        ...who(e.deviceId),
        scannedAt: null as number | null,
        correctedAt: e.correctedAt.getTime(),
        receivedAt: e.createdAt.getTime(),
        result: 'applied',
        held: false,
        released: false,
        heldAt: null as number | null,
        ...outcome(e),
      }));

    return {
      code: b.code,
      status: b.status,
      nextOp: nextOpOf(b),
      round: b.reworkRound,
      owner: b.guest?.name ?? 'sim',
      wastedMills: await wasteOf(this.prisma, b.id),
      events: [...fromInbox, ...fromEvents].sort((a, c) => a.correctedAt - c.correctedAt),
    };
  }

  async held() {
    const now = this.clock.now().getTime();
    const rows = await this.prisma.heldEvent.findMany({ orderBy: { heldAt: 'asc' }, take: 200 });
    const inbox = new Map(
      (await this.prisma.scanInbox.findMany({ where: { id: { in: rows.map((r) => r.inboxId) } } })).map((r) => [r.id, r]),
    );
    const bundles = new Map(
      (await this.prisma.bundle.findMany({ where: { id: { in: rows.map((r) => r.bundleId) } } })).map((b) => [b.id, b]),
    );
    const devices = new Map(
      (await this.prisma.device.findMany({ where: { id: { in: [...inbox.values()].map((r) => r.deviceId) } } })).map(
        (d) => [d.id, d],
      ),
    );
    return rows.map((h) => {
      const row = inbox.get(h.inboxId);
      const device = row && devices.get(row.deviceId);
      return {
        code: bundles.get(h.bundleId)?.code ?? null,
        op: row?.op ?? null,
        device: device ? deviceLabel(device) : null,
        heldAt: h.heldAt.getTime(),
        ageSec: Math.floor((now - h.heldAt.getTime()) / 1000),
        stuck: now - h.heldAt.getTime() > DAY_MS,
      };
    });
  }

  async stations() {
    const now = this.clock.now().getTime();
    const devices = await this.prisma.device.findMany({
      orderBy: [{ lastSyncAt: { sort: 'desc', nulls: 'last' } }, { registeredAt: 'desc' }],
      take: 200,
      include: { guest: { select: { name: true } } },
    });
    return devices.map((d) => ({
      device: deviceLabel(d),
      kind: deviceKind(d),
      guest: d.guest?.name,
      simName: d.simName ?? undefined,
      lastSyncAt: d.lastSyncAt?.getTime() ?? null,
      lastPending: d.lastPending,
      clockOffsetMs: d.clockOffsetMs,
      offlineFor: d.lastSyncAt ? Math.floor((now - d.lastSyncAt.getTime()) / 1000) : null,
    }));
  }

  async audit(action?: string) {
    const rows = await this.prisma.auditLog.findMany({
      where: action ? { action } : undefined,
      orderBy: { at: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({ ...r, at: r.at.getTime() }));
  }

  async setRate(who: Who, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const { op, ratePerPieceMills: mills } = b;
    if (typeof op !== 'string') throw new BadRequestException({ error: 'op required' });
    if (typeof mills !== 'number' || !Number.isSafeInteger(mills) || mills < 1 || mills > MAX_RATE_MILLS) {
      throw new BadRequestException({ error: 'ratePerPieceMills must be a whole number of mills' });
    }
    const effectiveFrom = typeof b.effectiveFrom === 'string' ? new Date(b.effectiveFrom) : new Date(NaN);
    if (Number.isNaN(effectiveFrom.getTime())) throw new BadRequestException({ error: 'effectiveFrom is not a date' });

    const style = await this.prisma.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    return this.prisma.$transaction(async (tx) => {
      const rates = await tx.pieceRate.findMany({ where: { styleId: style.id, op } });
      if (rates.length === 0) throw new BadRequestException({ error: `${op} has no piece rate` });
      // Two rows at one instant would tie for "in force"; an old row is never edited.
      if (rates.some((r) => r.effectiveFrom.getTime() === effectiveFrom.getTime())) {
        throw new ConflictException({ error: 'a rate already starts at that time' });
      }
      const before = rateIn(rates, effectiveFrom);
      const created = await tx.pieceRate.create({
        data: { styleId: style.id, op, ratePerPieceMills: mills, effectiveFrom },
      });
      await audit(
        tx,
        {
          actor: who.login,
          role: who.role,
          action: 'rate_change',
          entity: `rate:${op}`,
          before: before && {
            ratePerPieceMills: before.ratePerPieceMills,
            effectiveFrom: before.effectiveFrom.toISOString(),
          },
          after: { ratePerPieceMills: mills, effectiveFrom: effectiveFrom.toISOString() },
        },
        this.clock,
      );
      return { id: created.id, op, ratePerPieceMills: mills, effectiveFrom: effectiveFrom.toISOString() };
    });
  }

  // Guest data and this month's simulated rows go; closed months' postings, the
  // audit log, users and the line itself stay.
  async reset(who: Who) {
    const now = this.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const period = monthStart.toISOString().slice(0, 7);

    return this.prisma.$transaction(
      async (tx) => {
        const guests = await tx.guest.findMany({ select: { id: true } });
        await tx.$executeRaw`DELETE FROM "Posting"
          WHERE "period" = ${period} AND ("guestId" IS NOT NULL OR "guestPurged" OR "isSimulated")`;
        await deleteGuestData(
          tx,
          guests.map((g) => g.id),
        );

        const simBundles = Prisma.sql`(SELECT "id" FROM "Bundle"
          WHERE "isSimulated" AND "guestId" IS NULL AND "createdAt" >= ${monthStart})`;
        const simDevices = Prisma.sql`(SELECT "id" FROM "Device" WHERE "isSimulated")`;
        await tx.$executeRaw`DELETE FROM "HeldEvent" WHERE "bundleId" IN ${simBundles}`;
        await tx.$executeRaw`DELETE FROM "BundleEvent"
          WHERE "isSimulated" AND ("correctedAt" >= ${monthStart} OR "bundleId" IN ${simBundles})`;
        await tx.$executeRaw`DELETE FROM "ScanInbox" WHERE "deviceId" IN ${simDevices} AND "receivedAt" >= ${monthStart}`;
        await tx.$executeRaw`DELETE FROM "DeviceNotice" WHERE "deviceId" IN ${simDevices} AND "createdAt" >= ${monthStart}`;
        const simGone = await tx.$executeRaw`DELETE FROM "Bundle" WHERE "id" IN ${simBundles}`;

        const counts = { guests: guests.length, simBundles: simGone };
        await audit(
          tx,
          { actor: who.login, role: who.role, action: 'reset', entity: 'guest and sim data', after: counts },
          this.clock,
        );
        return counts;
      },
      { timeout: 60_000 },
    );
  }
}
