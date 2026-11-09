import { createHash } from 'node:crypto';
import { ForbiddenException, HttpException, Inject, Injectable } from '@nestjs/common';
import { Guest, GuestMode, Prisma } from '@prisma/client';
import { CLOCK, Clock } from '../clock';
import { hit } from '../limits';
import { STATIONS, StationCode, STYLE_CODE } from '../line/line';
import { rateAt } from '../line/rates';
import { PrismaService } from '../prisma.service';

type Tx = Prisma.TransactionClient;

const BUNDLES_PER_GUEST = 3;
const REFILLS_PER_DAY = 10;
const SIM_CUTTER = 'sim-cutter';

export type MeBody = {
  name: string;
  mode: GuestMode;
  serverNow: number;
  bundles: { code: string; status: string; nextOp: string | null; round: number; wastedMills: number }[];
};

export function hashIp(ip: string): string {
  return createHash('sha256')
    .update(ip + process.env.COOKIE_SECRET)
    .digest('hex');
}

// Loopback only: behind the proxy a remote client shows up as its forwarded
// address, so a sim key sent from outside never passes this check.
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  const bare = ip.replace(/^::ffff:/, '');
  return bare === '::1' || bare.startsWith('127.');
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
          const guest = await tx.guest.create({ data: { name, ipHash, lastActiveAt: now } });
          await this.addBundles(tx, guest.id, BUNDLES_PER_GUEST, now);
          return guest;
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    throw new HttpException({ error: 'could not name a guest, try again' }, 503);
  }

  // The guest owns the bundle and is paid for the cut; the sim cutter only
  // did the work, so the event is simulated and the posting is not.
  private async addBundles(tx: Tx, guestId: string, count: number, now: Date): Promise<void> {
    const style = await tx.style.findUniqueOrThrow({ where: { code: STYLE_CODE } });
    const rates = await tx.pieceRate.findMany({ where: { styleId: style.id } });
    const cutRate = rateAt(rates, style.id, 'cut', now);
    const cutter = await this.ensureSimDevice(tx, 'C-01', SIM_CUTTER, now);
    const afterCut = style.route.indexOf('sew_collar');
    const period = now.toISOString().slice(0, 7);

    const seq = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT nextval('bundle_code_seq') AS n FROM generate_series(1, ${count}::int)`;
    for (const { n } of seq) {
      const bundle = await tx.bundle.create({
        data: {
          code: `B-${String(n).padStart(4, '0')}`,
          styleId: style.id,
          pieces: style.piecesPerBundle,
          status: 'active',
          nextStep: afterCut,
          guestId,
        },
      });
      const event = await tx.bundleEvent.create({
        data: {
          bundleId: bundle.id,
          op: 'cut',
          source: 'gate',
          deviceId: cutter.id,
          round: 0,
          correctedAt: now,
          isSimulated: true,
        },
      });
      await tx.posting.create({
        data: {
          period,
          kind: 'labour',
          amountMills: cutRate * style.piecesPerBundle,
          bundleCode: bundle.code,
          eventId: event.id,
          guestId,
          isSimulated: false,
        },
      });
    }
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
      orderBy: { createdAt: 'asc' },
      include: { style: true },
    });
    const wasted = await this.prisma.bundleEvent.findMany({
      where: { bundleId: { in: bundles.map((b) => b.id) }, wasted: true },
    });
    const ops = await this.prisma.operation.findMany();
    const trims = new Map(ops.map((o) => [o.code, o.trimsMills]));
    const rates = await this.prisma.pieceRate.findMany();

    return {
      name: guest.name,
      mode: guest.mode,
      serverNow: now.getTime(),
      bundles: bundles.map((b) => {
        const wastedMills = wasted
          .filter((e) => e.bundleId === b.id)
          .reduce((sum, e) => sum + rateAt(rates, b.styleId, e.op, e.correctedAt) * b.pieces + (trims.get(e.op) ?? 0), 0);
        const done = b.status === 'packed' || b.status === 'shipped';
        return {
          code: b.code,
          status: b.status,
          nextOp: done ? null : (b.style.route[b.nextStep] ?? null),
          round: b.reworkRound,
          wastedMills,
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
    const waiting = [style.route.indexOf('sew_collar'), style.route.indexOf('sew_sleeve')];
    const stuck = await this.prisma.bundle.count({
      where: { guestId: guest.id, status: 'active', nextStep: { in: waiting } },
    });
    if (stuck > 0) throw new HttpException({ error: 'finish the bundles you have first' }, 409);

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

  registerSimDevice(station: StationCode, simName: string) {
    return this.prisma.$transaction((tx) => this.ensureSimDevice(tx, station, simName, this.clock.now()));
  }
}
