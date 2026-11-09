import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CLOCK, Clock } from '../clock';
import { PrismaService } from '../prisma.service';
import { Rabbit } from '../rabbit';
import { deleteGuestData, lockBundles, orphanPostings } from './guest-data';

const GUEST_TTL_MS = 24 * 60 * 60 * 1000;
const SIM_KEEP_MS = 60 * 24 * 60 * 60 * 1000;
const PER_PASS = 200;

// Worker only. A guest's data goes after 24 h; the postings made from it stay,
// as an orphan, so the money totals of a month never move because a visitor
// aged out. Audit rows are never touched.
@Injectable()
export class PurgeService {
  private readonly log = new Logger(PurgeService.name);
  private running = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(Rabbit) private readonly rabbit: Rabbit,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async runOnce(): Promise<number> {
    const now = this.clock.now().getTime();
    let purged = 0;
    for (;;) {
      const guests = await this.prisma.guest.findMany({
        where: { createdAt: { lt: new Date(now - GUEST_TTL_MS) } },
        select: { id: true },
        take: PER_PASS,
      });
      if (guests.length === 0) break;
      const ids = guests.map((g) => g.id);
      await this.prisma.$transaction(
        async (tx) => {
          await orphanPostings(tx, ids);
          await deleteGuestData(tx, ids);
        },
        { timeout: 30_000 },
      );
      purged += ids.length;
    }
    await this.dropOldSimRows(new Date(now - SIM_KEEP_MS));
    if (purged > 0) {
      const text = `purge ${purged} guests`;
      this.rabbit.publishHood({ t: now, kind: 'purge', proc: 'worker', text }).catch(() => undefined);
    }
    return purged;
  }

  // The sim never stops, so its rows would pile up; postings are the record
  // and stay.
  private async dropOldSimRows(before: Date): Promise<void> {
    // Raw, with subselects: a busy sim leaves far more rows than a bind list holds.
    await this.prisma.$transaction(async (tx) => {
      const sim = Prisma.sql`(SELECT "id" FROM "Device" WHERE "isSimulated")`;
      // Only a row the worker may still settle (unapplied or held) needs its
      // bundle locked first; the rest are done with.
      await lockBundles(
        tx,
        Prisma.sql`"code" IN (SELECT "bundleCode" FROM "ScanInbox"
          WHERE "deviceId" IN ${sim} AND "receivedAt" < ${before} AND ("result" IS NULL OR "result" = 'held'))`,
      );
      await tx.$executeRaw`DELETE FROM "HeldEvent" WHERE "inboxId" IN
        (SELECT "id" FROM "ScanInbox" WHERE "deviceId" IN ${sim} AND "receivedAt" < ${before})`;
      await tx.$executeRaw`DELETE FROM "ScanInbox" WHERE "deviceId" IN ${sim} AND "receivedAt" < ${before}`;
      await tx.$executeRaw`DELETE FROM "BundleEvent" WHERE "isSimulated" AND "correctedAt" < ${before}`;
    });
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'purge' })
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.log.error(`purge failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
