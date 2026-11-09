import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Device } from '@prisma/client';
import { Subject } from 'rxjs';
import { CLOCK, Clock } from '../clock';
import { hit } from '../limits';
import { Rabbit } from '../rabbit';
import type { HoodEvent } from './hood-event';

const KEEP = 200;

// How a device shows in a line: the station it stands at, never its id.
export function deviceLabel(device: Pick<Device, 'code'>): string {
  return `dev-${device.code.replace('-', '')}`;
}

// The API's window on the line. Its own lines are stored at once and also go
// out on the fanout for any other listener; worker lines arrive from the
// fanout. A line that comes back from the fanout carries this process's id and
// is skipped, or every API line would be stored twice.
@Injectable()
export class HoodService implements OnModuleInit {
  private readonly log = new Logger(HoodService.name);
  private readonly buffer: HoodEvent[] = [];
  readonly live = new Subject<HoodEvent>();

  constructor(
    @Inject(Rabbit) private readonly rabbit: Rabbit,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit() {
    await this.rabbit.consumeHood((e) => {
      if (e.pid !== this.rabbit.pid) this.store(e);
    });
  }

  emit(kind: HoodEvent['kind'], text: string): void {
    const e: HoodEvent = { t: this.clock.now().getTime(), kind, proc: 'api', text };
    this.store(e);
    // A lost fanout line only hides it from other listeners; this process has it.
    this.rabbit.publishHood(e).catch((err) => this.log.warn(`hood publish dropped: ${err.message}`));
  }

  // A client that keeps hitting a limit would otherwise fill the 200 with the
  // same refusal, so one line per device every 5 s is enough.
  emitLimit(device: Device, what: 'batch' | 'gate'): void {
    if (!hit(`hood-limit:${device.id}:${what}`, 1, 5, this.clock.now().getTime())) return;
    this.emit('limit', `limit ${deviceLabel(device)} ${what}`);
  }

  private store({ pid: _pid, ...e }: HoodEvent) {
    this.buffer.push(e);
    if (this.buffer.length > KEEP) this.buffer.shift();
    this.live.next(e);
  }

  recent(): HoodEvent[] {
    return [...this.buffer];
  }

  // Oldest first, like a log tail.
  tail(kinds: HoodEvent['kind'][], n: number): string[] {
    return this.buffer
      .filter((e) => kinds.includes(e.kind))
      .slice(-n)
      .map((e) => e.text);
  }
}
