import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { performance } from 'node:perf_hooks';
import { PeriodClose } from '@prisma/client';
import { CLOCK, Clock } from '../clock';
import { HoodService } from '../hood/hood';
import { PrismaService } from '../prisma.service';
import { closeMonth, dollars } from './close';
import { periodBounds, periodOf } from './period';

// API only: the hood buffer lives here, and the worker has no admin.
@Injectable()
export class CloseService {
  private readonly log = new Logger(CloseService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(HoodService) private readonly hood: HoodService,
  ) {}

  // The hood line goes out after commit, so a close that rolled back is never announced.
  async close(period: string, actor: string, role?: string): Promise<{ closed: boolean; close: PeriodClose }> {
    const now = this.clock.now();
    const started = performance.now();
    // The lock can wait behind a slow posting, and the WIP read covers a whole month.
    const out = await this.prisma.$transaction((tx) => closeMonth(tx, now, period, actor, role), {
      maxWait: 10_000,
      timeout: 120_000,
    });
    if (out.closed) {
      const ms = Math.round(performance.now() - started);
      this.hood.emit('close', `close ${period} · wip ${dollars(out.close.wipMills)} · ${ms} ms`);
    }
    return out;
  }

  // The month before the clock's, whatever the hour: a run missed at 00:05 on
  // the 1st is made up an hour later.
  runOnce() {
    const thisMonth = periodBounds(periodOf(this.clock.now())).start;
    return this.close(periodOf(new Date(thisMonth.getTime() - 1)), 'cron');
  }

  // Off in tests, where a fixed clock and a wall-clock schedule would close
  // some spec's month at random.
  @Cron('5 * * * *', { name: 'close', timeZone: 'UTC' })
  async tick() {
    if (process.env.CLOSE_ENABLED === '0') return;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(`month close failed: ${(err as Error).message}`);
    }
  }
}
