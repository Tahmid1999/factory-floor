import { BadRequestException, Controller, Get, Inject, NotFoundException, Query, Req } from '@nestjs/common';
import { BundleStatus } from '@prisma/client';
import type { Request } from 'express';
import { CLOCK, Clock } from '../clock';
import { isSimCaller } from '../guests/sim-caller';
import { mayScan } from '../guests/ownership';
import { POLO_ROUTE, STATIONS, StationCode } from '../line/line';
import { canFlag } from '../line/state-machine';
import { PrismaService } from '../prisma.service';

const MAX_WORK = 10;
// Candidates are read before mayScan filters them, so read more than we return.
const CANDIDATES = 100;
const QUIET_MS = 5 * 60 * 1000;
const COLLAR = POLO_ROUTE.indexOf('sew_collar');
const SLEEVE = POLO_ROUTE.indexOf('sew_sleeve');

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
  // rows mayScan could say yes to; mayScan stays the one rule.
  private async candidates(where: { status: BundleStatus | { in: BundleStatus[] }; nextStep?: number | { gt?: number; lte?: number } }) {
    const now = this.clock.now();
    const rows = await this.prisma.bundle.findMany({
      where: {
        ...where,
        OR: [
          { isSimulated: true },
          { nextStep: { gt: SLEEVE } },
          { guest: { lastActiveAt: { lte: new Date(now.getTime() - QUIET_MS) } } },
        ],
      },
      include: { guest: { select: { lastActiveAt: true } } },
      orderBy: [{ createdAt: 'asc' }, { code: 'asc' }],
      take: CANDIDATES,
    });
    return rows.filter((b) => mayScan({ sim: true }, { ...b, guestLastActiveAt: b.guest?.lastActiveAt ?? null }, now));
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
