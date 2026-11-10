import {
  BadRequestException,
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { performance } from 'node:perf_hooks';
import { PieceRate, PostingKind, Prisma } from '@prisma/client';
import { wasteOf, wasteOfMany } from '../apply/waste';
import { audit } from '../audit/audit';
import { CLOCK, Clock } from '../clock';
import { deviceLabel, HoodService } from '../hood/hood';
import { POLO_ROUTE, STYLE_CODE } from '../line/line';
import { PERIOD_RE } from '../money/close';
import { nextPeriod, periodOf } from '../money/period';
import { payrollOf, scansOf } from '../money/payroll';
import { pnlOf } from '../money/pnl';
import { CloseService } from '../money/close.service';
import { PrismaService } from '../prisma.service';
import { deleteGuestData, lockBundles, orphanPostings } from '../purge/guest-data';
import { stressRefusal } from '../limits';
import { ADJUST_REASONS, AdjustReason, adjust, issueFromRoll, onHandCm, receiveTestRoll } from '../stock/stock';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_MS = 5 * 60 * 1000;
const MAX_RATE_MILLS = 1_000_000;
// A bound on a typo, far above any one roll.
const MAX_ADJUST_CM = 1_000_000;
const STOCK_ROWS = 100;
const POSTING_ROWS = 100;
// The stress run: 20 issues of 10 m at once on a 100 m test roll.
const STRESS_ISSUES = 20;
const STRESS_CM = 1000;

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
    @Inject(CloseService) private readonly closer: CloseService,
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

  // Every month from the first posting to now, empty ones too. The ends are
  // one probe each on the period index; a GROUP BY read every posting ever
  // made. The last can be a month ahead: a scan corrected a minute past
  // midnight on the 1st.
  async periods() {
    const [first, last, closed] = await Promise.all([
      this.prisma.posting.findFirst({ orderBy: { period: 'asc' }, select: { period: true } }),
      this.prisma.posting.findFirst({ orderBy: { period: 'desc' }, select: { period: true } }),
      this.prisma.periodClose.findMany({ select: { period: true } }),
    ]);
    const done = new Set(closed.map((c) => c.period));
    const now = periodOf(this.clock.now());
    const from = [now, ...done, ...(first ? [first.period] : [])].sort()[0];
    const to = last && last.period > now ? last.period : now;
    const out: { period: string; closed: boolean }[] = [];
    for (let p = from; p <= to; p = nextPeriod(p)) out.unshift({ period: p, closed: done.has(p) });
    return out;
  }

  // One snapshot, so the lines, the close row and the WIP are of one moment.
  pnl(period: string | undefined, excludeSim: boolean) {
    const now = this.clock.now();
    const p = period ?? periodOf(now);
    if (!PERIOD_RE.test(p)) throw new BadRequestException({ error: 'period must be YYYY-MM' });
    return this.prisma.$transaction((tx) => pnlOf(tx, p, { excludeSim, now }), { isolationLevel: 'RepeatableRead' });
  }

  // Keyset on (createdAt, id), the order the rows are shown in, so a page
  // boundary stays put while the sim keeps posting at the top.
  async postings(q: { period?: string; kind?: string; late?: string; excludeSim: boolean; after?: string }) {
    if (q.period !== undefined && !PERIOD_RE.test(q.period)) throw new BadRequestException({ error: 'period must be YYYY-MM' });
    if (q.kind !== undefined && !(Object.values(PostingKind) as string[]).includes(q.kind)) throw new BadRequestException({ error: 'unknown kind' });
    const where: Prisma.PostingWhereInput[] = [];
    if (q.period) where.push({ period: q.period });
    if (q.kind) where.push({ kind: q.kind as PostingKind });
    if (q.late === '1') where.push({ adjustsPeriod: { not: null } });
    if (q.late === '0') where.push({ adjustsPeriod: null });
    if (q.excludeSim) where.push({ isSimulated: false });
    if (q.after) {
      const at = await this.prisma.posting.findUnique({ where: { id: q.after } });
      if (!at) throw new BadRequestException({ error: 'no such row to page from' });
      where.push({ OR: [{ createdAt: { lt: at.createdAt } }, { createdAt: at.createdAt, id: { lt: at.id } }] });
    }
    const page = await this.prisma.posting.findMany({
      where: { AND: where },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: POSTING_ROWS + 1,
    });
    const rows = page.slice(0, POSTING_ROWS);
    const events = await this.prisma.bundleEvent.findMany({
      where: { id: { in: rows.flatMap((r) => (r.eventId ? [r.eventId] : [])) } },
      select: { id: true, op: true, deviceId: true },
    });
    const devices = await this.prisma.device.findMany({
      where: { id: { in: events.flatMap((e) => (e.deviceId ? [e.deviceId] : [])) } },
    });
    const evOf = new Map(events.map((e) => [e.id, e]));
    const devOf = new Map(devices.map((d) => [d.id, d]));
    return {
      rows: rows.map((r) => {
        const e = r.eventId ? evOf.get(r.eventId) : undefined;
        const d = e?.deviceId ? devOf.get(e.deviceId) : undefined;
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          kind: r.kind,
          amountMills: r.amountMills,
          period: r.period,
          adjustsPeriod: r.adjustsPeriod,
          bundleCode: r.bundleCode,
          op: e?.op ?? null,
          device: d ? deviceLabel(d) : null,
          isSimulated: r.isSimulated,
        };
      }),
      next: page.length > POSTING_ROWS ? rows[rows.length - 1].id : null,
    };
  }

  async payroll(day: string | undefined) {
    const d = day ?? this.clock.now().toISOString().slice(0, 10);
    return { day: d, rows: await this.prisma.$transaction((tx) => payrollOf(tx, d), { isolationLevel: 'RepeatableRead' }) };
  }

  async scans(day: string | undefined, worker: string | undefined) {
    if (!day) throw new BadRequestException({ error: 'day required' });
    if (!worker) throw new BadRequestException({ error: 'worker required' });
    return { day, rows: await this.prisma.$transaction((tx) => scansOf(tx, day, worker)) };
  }

  async bundles(q?: string) {
    const rows = await this.prisma.bundle.findMany({
      where: q ? { code: { startsWith: q } } : undefined,
      orderBy: [{ createdAt: 'desc' }, { code: 'desc' }],
      take: 50,
      include: { guest: { select: { name: true } } },
    });
    const wasted = await wasteOfMany(
      this.prisma,
      rows.map((b) => b.id),
    );
    return rows.map((b) => ({
      code: b.code,
      status: b.status,
      nextOp: nextOpOf(b),
      round: b.reworkRound,
      owner: b.guest?.name ?? 'sim',
      wastedMills: wasted.get(b.id) ?? 0,
    }));
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

    // A visitor's bundle is cut by the sim before the visitor sees it, and
    // carried on by the sim after; the label says whose work a row was.
    const carried = (d: { isSimulated: boolean; simName: string | null }, op: string) => {
      if (!b.guestId || !d.isSimulated) return null;
      return op === 'cut' ? `cut by ${d.simName ?? 'sim'}` : 'sim-carried';
    };
    const who = (deviceId: string | null, op: string) => {
      const d = deviceId ? devices.get(deviceId) : undefined;
      return d
        ? { device: deviceLabel(d), deviceKind: deviceKind(d), label: carried(d, op) }
        : { device: null, deviceKind: null, label: null };
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
      ...who(r.deviceId, r.op),
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
        ...who(e.deviceId, e.op),
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

  // Newest first: issues take the oldest roll, so what still holds fabric is
  // at the top. On-hand is summed from the ledger in one grouped read, and only
  // for rolls not marked emptied; an emptied roll reads 0 without its history.
  async stock() {
    const rolls = await this.prisma.roll.findMany({
      where: { isTest: false },
      orderBy: [{ receivedAt: 'desc' }, { code: 'desc' }],
      take: STOCK_ROWS,
    });
    const sums = await this.prisma.stockMovement.groupBy({
      by: ['rollId'],
      where: { rollId: { in: rolls.filter((r) => r.emptiedAt === null).map((r) => r.id) } },
      _sum: { deltaCm: true },
    });
    const onHand = new Map(sums.map((s) => [s.rollId, s._sum.deltaCm ?? 0]));
    return rolls.map((r) => ({
      code: r.code,
      lengthCm: r.lengthCm,
      onHandCm: onHand.get(r.id) ?? 0,
      costPerMetreMills: r.costPerMetreMills,
      receivedAt: r.receivedAt.getTime(),
      isSimulated: r.isSimulated,
    }));
  }

  // Test rolls too, so the stress result can be opened.
  async movements(code: string) {
    const roll = await this.prisma.roll.findUnique({ where: { code } });
    if (!roll) throw new NotFoundException({ error: 'no such roll' });
    const rows = await this.prisma.stockMovement.findMany({ where: { rollId: roll.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    return rows.map((m) => ({
      kind: m.kind,
      deltaCm: m.deltaCm,
      bundleCode: m.bundleCode,
      actor: m.actor,
      reason: m.reason,
      isSimulated: m.isSimulated,
      at: m.at.getTime(),
    }));
  }

  async adjust(who: Who, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const { rollCode, deltaCm, reason } = b;
    if (typeof rollCode !== 'string' || rollCode.length > 32) throw new BadRequestException({ error: 'rollCode required' });
    if (!Number.isSafeInteger(deltaCm) || deltaCm === 0 || Math.abs(deltaCm as number) > MAX_ADJUST_CM) {
      throw new BadRequestException({ error: 'deltaCm must be a whole number of centimetres, not 0' });
    }
    if (!(ADJUST_REASONS as readonly unknown[]).includes(reason)) {
      throw new BadRequestException({ error: `reason must be one of ${ADJUST_REASONS.join(', ')}` });
    }
    const now = this.clock.now();
    const out = await this.prisma.$transaction((tx) =>
      adjust(tx, now, who, { rollCode, deltaCm: deltaCm as number, reason: reason as AdjustReason }),
    );
    this.hood.emit('stock', `stock adjust ${out.rollCode} ${deltaCm} cm ${reason}`);
    return out;
  }

  async close(who: Who, body: unknown) {
    const { period } = (body ?? {}) as Record<string, unknown>;
    if (typeof period !== 'string' || !PERIOD_RE.test(period)) {
      throw new BadRequestException({ error: 'period must be YYYY-MM' });
    }
    const { closed, close } = await this.closer.close(period, who.login, who.role);
    return { closed, close: { ...close, closedAt: close.closedAt.getTime() } };
  }

  // Each issue is its own transaction, as 20 cutting tables would be, so the
  // roll lock is what keeps them from taking more than the roll holds.
  async stress(ip: string) {
    const now = this.clock.now();
    const refusal = stressRefusal(ip, now.getTime());
    if (refusal) throw new HttpException({ error: refusal }, 429);
    const roll = await this.prisma.$transaction((tx) => receiveTestRoll(tx, now));
    const started = performance.now();
    const results = await Promise.all(
      Array.from({ length: STRESS_ISSUES }, () =>
        this.prisma.$transaction((tx) => issueFromRoll(tx, now, roll.id, STRESS_CM, 'stress'), { maxWait: 10_000 }),
      ),
    );
    const ms = Math.round(performance.now() - started);
    const accepted = results.filter(Boolean).length;
    const refused = results.length - accepted;
    const left = await onHandCm(this.prisma, roll.id);
    this.hood.emit('stress', `stress ${roll.code} · ${accepted} taken · ${refused} refused · ${ms} ms`);
    return { roll: roll.code, accepted, refused, onHandCm: left, ms };
  }

  // Guest data and this month's simulated rows go; closed months' postings, the
  // audit log, users, the line itself and the stock ledger stay. The fabric
  // the reset bundles took stays issued: the ledger is append-only.
  async reset(who: Who) {
    const now = this.clock.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const period = monthStart.toISOString().slice(0, 7);

    return this.prisma.$transaction(
      async (tx) => {
        const simBundles = Prisma.sql`(SELECT "id" FROM "Bundle"
          WHERE "isSimulated" AND "guestId" IS NULL AND "createdAt" >= ${monthStart})`;
        const simDevices = Prisma.sql`(SELECT "id" FROM "Device" WHERE "isSimulated")`;
        // Every bundle whose rows go below, before any of them: the sim keeps
        // applying while this runs.
        await lockBundles(
          tx,
          Prisma.sql`"guestId" IS NOT NULL OR "id" IN ${simBundles} OR "code" IN
            (SELECT "bundleCode" FROM "ScanInbox" WHERE "deviceId" IN ${simDevices} AND "receivedAt" >= ${monthStart})`,
        );
        const guests = await tx.guest.findMany({ select: { id: true } });
        const guestIds = guests.map((g) => g.id);
        await tx.$executeRaw`DELETE FROM "Posting"
          WHERE "period" = ${period} AND ("guestId" IS NOT NULL OR "guestPurged" OR "isSimulated")`;
        // What is left of a live guest's is an earlier month's, which stays
        // as the purge would leave it.
        await orphanPostings(tx, guestIds);
        await deleteGuestData(tx, guestIds);

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
