import { BadRequestException, Body, Controller, Inject, NotFoundException, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { CLOCK, Clock } from '../clock';
import { isSimCaller } from '../guests/sim-caller';
import { HoodService } from '../hood/hood';
import { PrismaService } from '../prisma.service';
import { receive } from './stock';

const MAX_ROLLS = 12;

// The sim's storekeeper receives fabric here. Like /sim/*, anyone without the
// sim key from the worker's address gets the 404 an unknown route gets: a
// visitor never adds stock.
@Controller('stock')
export class StockController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(HoodService) private readonly hood: HoodService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Post('receive')
  async receive(@Req() req: Request, @Body() raw: unknown) {
    if (!isSimCaller(req.header('x-sim-key'), req.socket.remoteAddress, req.headers)) throw new NotFoundException();
    const b = (raw ?? {}) as Record<string, unknown>;
    const { count, costPerMetreMills: cost } = b;
    if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_ROLLS) {
      throw new BadRequestException({ error: `count must be 1 to ${MAX_ROLLS}` });
    }
    // The lot prices the sim draws: 3200 to 3600 a metre in steps of 50.
    if (!Number.isInteger(cost) || (cost as number) < 3200 || (cost as number) > 3600 || (cost as number) % 50 !== 0) {
      throw new BadRequestException({ error: 'costPerMetreMills must be 3200 to 3600 in steps of 50' });
    }
    const rolls = await this.prisma.$transaction((tx) =>
      receive(tx, this.clock.now(), {
        count: count as number,
        costPerMetreMills: cost as number,
        actor: 'sim-store',
        isSimulated: true,
      }),
    );
    const span = rolls.length === 1 ? rolls[0].code : `${rolls[0].code}..${rolls[rolls.length - 1].code}`;
    this.hood.emit('stock', `stock receive ${span} · ${cost} mills/m`);
    return { rolls: rolls.map((r) => r.code) };
  }
}
