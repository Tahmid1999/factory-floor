import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { CLOCK, Clock } from '../clock';
import { PrismaService } from '../prisma.service';
import { Rabbit } from '../rabbit';

const UNAPPLIED_AFTER_MS = 30_000;
// A broker outage can leave thousands behind; the next tick takes the rest.
const PER_RUN = 1000;

@Injectable()
export class SweepService {
  private readonly log = new Logger(SweepService.name);
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Rabbit) private readonly rabbit: Rabbit,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // Ingest publishes after commit and gives up while the broker is down, so
  // those rows sit with no result until this finds them. A row still queued
  // behind a slow worker may go out twice; apply skips the second copy.
  async runOnce(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - UNAPPLIED_AFTER_MS);
    const rows = await this.prisma.scanInbox.findMany({
      where: { result: null, receivedAt: { lt: before } },
      orderBy: { receivedAt: 'asc' },
      select: { id: true },
      take: PER_RUN,
    });
    let sent = 0;
    for (const { id } of rows) {
      try {
        await this.rabbit.publishApply(id);
        sent++;
      } catch (err) {
        this.log.warn(`sweep stopped, broker still down: ${(err as Error).message}`);
        break;
      }
    }
    if (sent > 0) {
      const text = `sweep republished ${sent}`;
      const t = this.clock.now().getTime();
      this.rabbit.publishHood({ t, kind: 'sweep', proc: 'worker', text }).catch(() => undefined);
    }
    return sent;
  }

  // A tick that outlasts 30 s must not start a second sweep over the same rows.
  @Interval('sweep', 30_000)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(`sweep failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
