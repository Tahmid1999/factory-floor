import 'reflect-metadata';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { PrismaClient } from '@prisma/client';
import { config } from 'dotenv';
import { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AppModule } from './app.module';
import { FixedClock, shareClock } from './clock';
import { dollars } from './money/close';
import { CloseService } from './money/close.service';
import { nextPeriod, periodBounds, periodOf } from './money/period';
import { pnlLines } from './money/pnl';
import { PrismaService } from './prisma.service';
import { seedLine } from './seed';
import { SimService, simConfigFromEnv } from './sim/sim.service';
import { WorkerModule } from './worker.module';

// The deploy empties the database and runs the line from here to the moment
// the run started, so October is a whole month with a real close.
const SEED_FROM = new Date('2026-10-01T00:00:00Z');
// A move costs about 17 ms of wall time here (http, the transaction, the
// worker's apply) and every tick waits ~20 ms for the worker to settle, so the
// live pace (1 move every 3 s, 10 every 30 s) took 570 s a sim-day locally,
// against a budget of 43 s (42 days in an hour on a VM half as fast). Even 1
// move every 30 s took 112 s. 6 moves every 5 min fits at 38 s a sim-day:
// October is seeded at about 6% of the live pace. The tick divides 5 min, so
// 00:05 and the 23:50 to 00:20 outage fall on ticks.
const SEED_TICK_MS = 300_000;
const SEED_MOVES_PER_TICK = 6;
const LIVE_MOVES_PER_MS = 1 / 3000;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
// The cron closes at minute 5 of the hour; the seed does it at the same minute.
const CLOSE_AT = 5 * MIN;
// S-09 goes off the network at 23:50 on the last day and back at 00:20 on the
// 1st, so the close at 00:05 falls inside its outage.
const LATE_STATION = 'S-09';
const LATE_BEFORE = 10 * MIN;
const LATE_AFTER = 20 * MIN;

const SETTLE_POLL_MS = 5;
const SETTLE_GIVE_UP_MS = 5000;

export type Summary = {
  ticks: number;
  simDays: number;
  seconds: number;
  ticksPerSecond: number;
  secondsPerSimDay: number;
  bundles: number;
  postings: number;
  // Per month the run touched, every posting in it, adjustments included.
  contribution: Record<string, number>;
  closes: { period: string; wipMills: number; ms: number }[];
  // Postings booked after a close for work dated before it: S-09's outage.
  // At 6 moves a tick S-09 gets about one move in its October minutes, so
  // this is small, and 0 means the P&L has no late line to show.
  late: number;
  // Moves per sim-hour against the live sim's; 1 is the same pace.
  pace: number;
  // Ticks after which the worker had not settled within 5 s.
  unsettled: number;
};

async function refusal(prisma: PrismaClient): Promise<string | null> {
  if (process.env.SEED_MODE !== '1') return 'SEED_MODE=1 is not set; it turns the request limits off for this process';
  const n = await prisma.bundle.count();
  if (n > 0) return `the Bundle table is not empty (${n}); the seed runs once, on an emptied database`;
  return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The worker applies after the api has replied, so the next tick waits for
// every inbox row to have a result. Held rows have one ('held').
async function settled(prisma: PrismaService): Promise<boolean> {
  const end = Date.now() + SETTLE_GIVE_UP_MS;
  for (;;) {
    if (!(await prisma.scanInbox.findFirst({ where: { result: null }, select: { id: true } }))) return true;
    if (Date.now() > end) return false;
    await sleep(SETTLE_POLL_MS);
  }
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const stamp = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

// The real sim, api and worker in one process on one stepped clock. The sim
// talks to the api over http on loopback as it does live; only time is fast.
export async function runHistory(o: {
  from: Date;
  until: () => Date;
  tickMs: number;
  movesPerTick: number;
  log?: (s: string) => void;
}): Promise<Summary> {
  const log = o.log ?? ((s: string) => console.log(s));
  const check = new PrismaClient();
  try {
    const why = await refusal(check);
    if (why) throw new Error(`refusing to seed: ${why}`);
    // On an emptied database this is the line and its 6 opening rolls, dated
    // when the run starts so the stock ledger reads in order.
    await seedLine(check, o.from);
  } finally {
    await check.$disconnect();
  }

  // No timer of the worker's sim, and no close on the wall clock: the run
  // closes each month itself, on the stepped clock.
  process.env.SIM_ENABLED = '0';
  process.env.CLOSE_ENABLED = '0';
  const clock = new FixedClock(o.from);
  shareClock(clock);
  let api: INestApplication | undefined;
  let worker: INestApplicationContext | undefined;
  try {
    api = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
    await api.listen(0, '127.0.0.1');
    worker = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
    // The hourly purge would fire on the wall clock against a clock that is
    // weeks behind it. Nothing is old enough to go, but it would lock bundles
    // mid-tick for nothing. The 30 s sweep stays: it only republishes rows
    // unapplied for 30 s of this clock, which a settled tick never leaves.
    api.get(SchedulerRegistry).deleteCronJob('close');
    worker.get(SchedulerRegistry).deleteCronJob('purge');

    const prisma = api.get(PrismaService);
    const closer = api.get(CloseService);
    const port = (api.getHttpServer().address() as AddressInfo).port;
    const sim = new SimService(
      {
        ...simConfigFromEnv(process.env),
        baseUrl: `http://127.0.0.1:${port}`,
        tickMs: o.tickMs,
        movesPerTick: o.movesPerTick,
      },
      clock,
    );

    const pace = o.movesPerTick / o.tickMs / LIVE_MOVES_PER_MS;
    log(
      `seed ${stamp(o.from)} to ${stamp(o.until())} UTC · tick ${o.tickMs} ms · ${o.movesPerTick} moves` +
        (pace < 1 ? ` · seeded at about ${pct(pace)} of the live pace` : ''),
    );

    const first = periodOf(o.from);
    const closes: Summary['closes'] = [];
    const scripted = new Set<string>();
    const started = performance.now();
    let ticks = 0;
    let unsettled = 0;
    let nextDay = o.from.getTime() + DAY;

    while (clock.now() < o.until()) {
      const t = clock.now().getTime();
      const month = periodOf(clock.now());
      const { start, end } = periodBounds(month);
      const prev = periodOf(new Date(start.getTime() - 1));
      if (prev >= first && !closes.some((c) => c.period === prev) && t >= start.getTime() + CLOSE_AT) {
        const t0 = performance.now();
        const out = await closer.close(prev, 'seed');
        const ms = Math.round(performance.now() - t0);
        closes.push({ period: prev, wipMills: out.close.wipMills, ms });
        log(`close ${prev} · wip ${dollars(out.close.wipMills)} · ${ms} ms`);
      }
      // Scripted, not drawn, and the README says so: the late scans from the
      // month before that the P&L shows are this outage.
      if (!scripted.has(month) && t >= end.getTime() - LATE_BEFORE) {
        sim.forceOffline(LATE_STATION, end.getTime() + LATE_AFTER);
        scripted.add(month);
        log(`${LATE_STATION} offline ${stamp(clock.now())} to ${stamp(new Date(end.getTime() + LATE_AFTER))}, scripted`);
      }

      await sim.tick();
      if (!(await settled(prisma))) {
        unsettled++;
        log(`tick ${stamp(clock.now())}: worker not settled after ${SETTLE_GIVE_UP_MS} ms, going on`);
      }
      clock.advance(o.tickMs);
      ticks++;

      if (clock.now().getTime() >= nextDay) {
        nextDay += DAY;
        const s = ((performance.now() - started) / 1000).toFixed(1);
        log(`${stamp(clock.now())} · ${await prisma.bundle.count()} bundles · ${s} s`);
      }
    }

    // A phone still off the network would take its queue with it when this
    // process exits.
    for (const dev of sim.batch.values()) await dev.setOnline(true);
    if (!(await settled(prisma))) unsettled++;

    const seconds = (performance.now() - started) / 1000;
    const simDays = (ticks * o.tickMs) / DAY;
    const contribution: Record<string, number> = {};
    for (let p = first; p <= periodOf(clock.now()); p = nextPeriod(p)) {
      contribution[p] = (await prisma.$transaction((tx) => pnlLines(tx, p, { excludeSim: false }))).contribution;
    }
    const summary: Summary = {
      ticks,
      simDays,
      seconds,
      ticksPerSecond: ticks / seconds,
      secondsPerSimDay: simDays > 0 ? seconds / simDays : 0,
      bundles: await prisma.bundle.count(),
      postings: await prisma.posting.count(),
      contribution,
      closes,
      late: await prisma.posting.count({ where: { adjustsPeriod: { not: null } } }),
      pace,
      unsettled,
    };
    log(
      `bundles ${summary.bundles} · postings ${summary.postings} · ` +
        Object.entries(contribution)
          .map(([p, m]) => `contribution ${p} ${dollars(m)}`)
          .join(' · ') +
        ` · ${summary.late} late · ${seconds.toFixed(1)} s · ${summary.ticksPerSecond.toFixed(1)} ticks/s · ${summary.secondsPerSimDay.toFixed(1)} s per sim-day` +
        (unsettled > 0 ? ` · ${unsettled} unsettled ticks` : ''),
    );
    return summary;
  } finally {
    await worker?.close();
    await api?.close();
    shareClock(undefined);
  }
}

async function main() {
  config({ path: resolve(__dirname, '../../.env') });
  await runHistory({ from: SEED_FROM, until: () => new Date(), tickMs: SEED_TICK_MS, movesPerTick: SEED_MOVES_PER_TICK });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`seed:history: ${(err as Error).message}`);
    process.exitCode = 1;
  });
}
