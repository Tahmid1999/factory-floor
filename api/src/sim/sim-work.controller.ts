import { BadRequestException, Controller, Get, Inject, NotFoundException, Query, Req } from '@nestjs/common';
import { BundleStatus, Prisma } from '@prisma/client';
import type { Request } from 'express';
import { CLOCK, Clock } from '../clock';
import { isSimCaller } from '../guests/sim-caller';
import { mayScan } from '../guests/ownership';
import { POLO_ROUTE, STATIONS, StationCode } from '../line/line';
import { canFlag } from '../line/state-machine';
import { PrismaService } from '../prisma.service';

const MAX_WORK = 10;
// mayScan filters after the read, so a page of a visitor's bundles that the
// sim must leave alone could otherwise hide the sim's own work behind it.
const PAGE = 100;
const MAX_PAGES = 5;
const COLLAR = POLO_ROUTE.indexOf('sew_collar');

export type SimWork = { code: string; nextOp: string | null; flaggedAt?: number };

// What the simulated line asks before each move: what is waiting at my
// station. It reads, it never writes, and it answers to the sim key from this
// machine only. Anyone else gets the 404 every unknown route gets.
@Controller('sim')
export class SimWorkController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('work')
  async work(@Req() req: Request, @Query('station') station?: string) {
    const key = req.header('x-sim-key');
    if (!isSimCaller(key, req.socket.remoteAddress, req.headers)) throw new NotFoundException();
    if (!station || !Object.prototype.hasOwnProperty.call(STATIONS, station)) {
      throw new BadRequestException({ error: 'unknown station' });
    }
    const code = station as StationCode;
    if (code === 'C-01') return { waitingAtCollar: (await this.waiting('active', COLLAR)).length };
    if (code === 'SUP') return { bundles: await this.rework() };
    if (code === 'Q-01') return { bundles: await this.flaggable() };
    const op = STATIONS[code].op;
    const at = POLO_ROUTE.indexOf(op);
    // A packed bundle waits for the ship scan, and pack is the step that
    // makes it packed.
    const status: BundleStatus[] = op === 'ship' ? ['packed'] : ['active'];
    return { bundles: (await this.waiting(status, at)).slice(0, MAX_WORK).map((b) => ({ code: b.code, nextOp: op })) };
  }

  // Oldest first, and only what the sim may scan. The query narrows to the
  // station; who may scan is mayScan's call alone, so the rule is never
  // written twice.
  private async candidates(where: Prisma.BundleWhereInput) {
    const now = this.clock.now();
    const out: Prisma.BundleGetPayload<{ include: { guest: { select: { lastActiveAt: true } } } }>[] = [];
    for (let page = 0; page < MAX_PAGES && out.length < MAX_WORK; page++) {
      const rows = await this.prisma.bundle.findMany({
        where,
        include: { guest: { select: { lastActiveAt: true } } },
        orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
        skip: page * PAGE,
        take: PAGE,
      });
      out.push(...rows.filter((b) => mayScan({ sim: true }, { ...b, guestLastActiveAt: b.guest?.lastActiveAt ?? null }, now)));
      if (rows.length < PAGE) break;
    }
    return out;
  }

  private waiting(status: BundleStatus | BundleStatus[], nextStep: number) {
    return this.candidates({ status: Array.isArray(status) ? { in: status } : status, nextStep });
  }

  private async flaggable(): Promise<SimWork[]> {
    const rows = await this.candidates({ status: 'active', nextStep: { gt: COLLAR, lte: POLO_ROUTE.indexOf('qc_final') } });
    return rows
      .filter((b) => canFlag({ status: b.status, nextStep: b.nextStep, route: POLO_ROUTE, reworkRound: b.reworkRound }))
      .slice(0, MAX_WORK)
      .map((b) => ({ code: b.code, nextOp: POLO_ROUTE[b.nextStep] ?? null }));
  }

  // The flag time lets the supervisor leave a bundle alone for a minute, the
  // way a person walks over, instead of clearing it the moment it is flagged.
  private async rework(): Promise<SimWork[]> {
    const rows = (await this.candidates({ status: 'rework' })).slice(0, MAX_WORK);
    const flags = await this.prisma.bundleEvent.findMany({
      where: { bundleId: { in: rows.map((b) => b.id) }, op: { in: ['qc_flag', 'qc_fail'] } },
      select: { bundleId: true, correctedAt: true },
    });
    const flaggedAt = new Map<string, number>();
    for (const f of flags) flaggedAt.set(f.bundleId, Math.max(flaggedAt.get(f.bundleId) ?? 0, f.correctedAt.getTime()));
    return rows.map((b) => ({
      code: b.code,
      nextOp: POLO_ROUTE[b.nextStep] ?? null,
      flaggedAt: flaggedAt.get(b.id),
    }));
  }
}
