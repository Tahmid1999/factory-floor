import { createHash } from 'node:crypto';
import { ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { Bundle, BundleEvent, Device, Guest, GuestMode, Prisma } from '@prisma/client';
import { CLOCK, Clock } from '../clock';
import { hit } from '../limits';
import { STATIONS, StationCode, STYLE_CODE } from '../line/line';
import { rateAt } from '../line/rates';
import { post } from '../money/postings';
import { wasteOfMany } from '../apply/waste';
import { PrismaService } from '../prisma.service';
import { issueForBundle, OutOfFabric } from '../stock/stock';

type Tx = Prisma.TransactionClient;

const BUNDLES_PER_GUEST = 3;
const REFILLS_PER_DAY = 10;
const SIM_CUTTER = 'sim-cutter';

const outOfFabric = () => new HttpException({ error: 'line out of fabric, try in a minute' }, 503);

export type MeBody = {
  // The station keys its devices by this: names are drawn again for new
  // guests, so a later visitor can get an earlier one's name.
  guestId: string;
  name: string;
  mode: GuestMode;
  serverNow: number;
  // Mills per piece and trims per bundle, as of now. The station prices its
  // own tally and the waste it avoided from these, never from a copy of its own.
  rates: Record<string, number>;
  trims: Record<string, number>;
  bundles: {
    code: string;
    status: string;
    nextOp: string | null;
    round: number;
    pieces: number;
    wastedMills: number;
    // Labour actually posted per op over every round, so a redo shows what it was paid.
    paid: Record<string, number>;
  }[];
};

export function hashIp(ip: string): string {
  return createHash('sha256')
    .update(ip + process.env.COOKIE_SECRET)
    .digest('hex');
}

@Injectable()
export class GuestsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  findGuest(id: string): Promise<Guest | null> {
    return this.prisma.guest.findUnique({ where: { id } });
  }

  touch(id: string): Promise<Guest> {
    return this.prisma.guest.update({ where: { id }, data: { lastActiveAt: this.clock.now() } });
  }

  async createGuest(ip: string): Promise<Guest> {
    const ipHash = hashIp(ip);
    const now = this.clock.now();
    if (!hit(`newguest:${ipHash}`, 5, 3600, now.getTime())) {
      throw new HttpException({ error: 'too many new guests from this network, try in an hour' }, 429);
    }
    // The name is a short random number, so a clash with a live guest is
    // possible; the unique index decides and we draw again.
    for (let attempt = 0; attempt < 8; attempt++) {
      const name = `guest-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
      try {
        return await this.prisma.$transaction(async (tx) => {
          const guest = await tx.guest.create({ data: { name, ipHash, lastActiveAt: now, createdAt: now } });
          await this.addBundles(tx, guest.id, BUNDLES_PER_GUEST, now);
          return guest;
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        if (e instanceof OutOfFabric) throw outOfFabric();
        throw e;
      }
    }
    throw new HttpException({ error: 'could not name a guest, try again' }, 503);
  }

  private async addBundles(tx: Tx, guestId: string, count: number, now: Date): Promise<void> {
    const cutter = await this.ensureSimDevice(tx, 'C-01', SIM_CUTTER, now);
    await this.cutBundles(tx, { count, guestId, cutter, now });
  }

  // Shared by a new visitor's bundles and the sim's C-01 gate, so every code
  // comes from the one sequence. A bundle with no guest belongs to the sim.
  // The cut event and posting follow the cutter: a visitor's bundle cut by the
  // sim is still the sim's work, so "exclude simulated" leaves only what the
  // visitor scanned. With no roll to cut from it throws OutOfFabric, and the
  // caller's transaction takes every bundle of the call back with it.
  async cutBundles(
    tx: Tx,
    o: { count: number; guestId: string | null; cutter: Device; now: Date; gateId?: string },
  ): Promise<{ bundle: Bundle; event: BundleEvent }[]> {
    const style = await tx.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    const rates = await tx.pieceRate.findMany({ where: { styleId: style.id } });
    const cutRate = rateAt(rates, style.id, 'cut', o.now);
    const afterCut = style.route.indexOf('sew_collar');

    const seq = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT nextval('bundle_code_seq') AS n FROM generate_series(1, ${o.count}::int)`;
    const cut: { bundle: Bundle; event: BundleEvent }[] = [];
    for (const { n } of seq) {
      const bundle = await tx.bundle.create({
        data: {
          code: `B-${String(n).padStart(4, '0')}`,
          styleId: style.id,
          pieces: style.piecesPerBundle,
          status: 'active',
          nextStep: afterCut,
          guestId: o.guestId,
          isSimulated: o.guestId === null,
          createdAt: o.now,
        },
      });
      const event = await tx.bundleEvent.create({
        data: {
          bundleId: bundle.id,
          op: 'cut',
          source: 'gate',
          deviceId: o.cutter.id,
          gateId: o.gateId,
          round: 0,
          correctedAt: o.now,
          isSimulated: o.cutter.isSimulated,
          createdAt: o.now,
        },
      });
      await post(tx, o.now, {
        kind: 'labour',
        amountMills: cutRate * style.piecesPerBundle,
        at: o.now,
        bundleCode: bundle.code,
        eventId: event.id,
        guestId: o.guestId,
        isSimulated: o.cutter.isSimulated,
      });
      const fabric = await issueForBundle(tx, o.now, {
        bundleCode: bundle.code,
        actor: o.cutter.simName ?? 'sim',
        isSimulated: o.cutter.isSimulated,
        eventId: event.id,
        guestId: o.guestId,
      });
      if (!fabric) throw new OutOfFabric();
      cut.push({ bundle, event });
    }
    return cut;
  }

  // Idempotent per (simName, station). The unique index cannot do it because
  // sim devices have a NULL guestId, so a transaction-scoped advisory lock
  // keeps two concurrent callers from both creating the row.
  async ensureSimDevice(tx: Tx, station: StationCode, simName: string, now: Date) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'sim-device:' + station + ':' + simName}))`;
    const found = await tx.device.findFirst({ where: { isSimulated: true, code: station, simName } });
    if (found) return found;
    return tx.device.create({
      data: { code: station, simName, isSimulated: true, guestId: null, registeredAt: now },
    });
  }

  async me(guest: Guest): Promise<MeBody> {
    const now = this.clock.now();
    const bundles = await this.prisma.bundle.findMany({
      where: { guestId: guest.id },
      // Bundles cut together share a timestamp; the code keeps the order fixed.
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
      include: { style: true },
    });
    const wastedMills = await wasteOfMany(
      this.prisma,
      bundles.map((b) => b.id),
    );
    const paid = new Map<string, Record<string, number>>();
    if (bundles.length > 0) {
      const rows = await this.prisma.$queryRaw<{ bundleCode: string; op: string; mills: bigint }[]>`
        SELECT p."bundleCode", e."op", SUM(p."amountMills") AS mills
        FROM "Posting" p JOIN "BundleEvent" e ON e."id" = p."eventId"
        WHERE p."kind" = 'labour' AND p."bundleCode" IN (${Prisma.join(bundles.map((b) => b.code))})
        GROUP BY p."bundleCode", e."op"`;
      for (const r of rows) paid.set(r.bundleCode, { ...paid.get(r.bundleCode), [r.op]: Number(r.mills) });
    }

    const style = await this.prisma.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    const pieceRates = await this.prisma.pieceRate.findMany({ where: { styleId: style.id } });
    const rates: Record<string, number> = {};
    for (const op of new Set(pieceRates.map((r) => r.op))) {
      // Only rates already in force; one effective later is not paid yet.
      if (pieceRates.some((r) => r.op === op && r.effectiveFrom <= now)) rates[op] = rateAt(pieceRates, style.id, op, now);
    }
    const trims: Record<string, number> = {};
    for (const o of await this.prisma.operation.findMany()) if (o.trimsMills > 0) trims[o.code] = o.trimsMills;

    return {
      guestId: guest.id,
      name: guest.name,
      mode: guest.mode,
      serverNow: now.getTime(),
      rates,
      trims,
      bundles: bundles.map((b) => {
        const done = b.status === 'packed' || b.status === 'shipped';
        return {
          code: b.code,
          status: b.status,
          nextOp: done ? null : (b.style.route[b.nextStep] ?? null),
          round: b.reworkRound,
          pieces: b.pieces,
          wastedMills: wastedMills.get(b.id) ?? 0,
          paid: paid.get(b.code) ?? {},
        };
      }),
    };
  }

  setMode(guestId: string, mode: GuestMode): Promise<Guest> {
    return this.prisma.guest.update({ where: { id: guestId }, data: { mode } });
  }

  async refill(guest: Guest): Promise<MeBody> {
    const now = this.clock.now();
    const style = await this.prisma.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    // Only an untouched bundle blocks a refill. One redone after rework waits
    // at the sleeve again, and holding the visitor to it would stall the demo.
    const untouched = await this.prisma.bundle.findFirst({
      where: { guestId: guest.id, status: 'active', reworkRound: 0, nextStep: style.route.indexOf('sew_collar') },
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
    });
    if (untouched) {
      throw new HttpException({ error: 'finish the bundles you have first', bundle: untouched.code }, 409);
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        // The conditional update is the counter, so two parallel refills cannot
        // both take the last slot.
        const taken = await tx.guest.updateMany({
          where: { id: guest.id, refillsToday: { lt: REFILLS_PER_DAY } },
          data: { refillsToday: { increment: 1 } },
        });
        if (taken.count === 0) throw new HttpException({ error: 'refill limit reached for today' }, 429);
        await this.addBundles(tx, guest.id, BUNDLES_PER_GUEST, now);
      });
    } catch (e) {
      // The refill rolled back with the cut, so it does not count against the day.
      if (e instanceof OutOfFabric) throw outOfFabric();
      throw e;
    }
    return this.me((await this.findGuest(guest.id))!);
  }

  async registerGuestDevice(guestId: string, station: StationCode) {
    if (STATIONS[station].simOnly) throw new ForbiddenException({ error: 'that station is simulated only' });
    return this.prisma.device.upsert({
      where: { guestId_code: { guestId, code: station } },
      update: {},
      create: { guestId, code: station, registeredAt: this.clock.now() },
    });
  }

  // The highest seq the server holds for a device, so a station whose own
  // counter was wiped carries on above it instead of reusing a seq.
  async lastSeq(deviceId: string): Promise<number> {
    const r = await this.prisma.scanInbox.aggregate({ where: { deviceId }, _max: { seq: true } });
    return r._max.seq ?? 0;
  }

  registerSimDevice(station: StationCode, simName: string) {
    return this.prisma.$transaction((tx) => this.ensureSimDevice(tx, station, simName, this.clock.now()));
  }
}
