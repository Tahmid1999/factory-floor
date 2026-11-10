export const CLOCK = Symbol('CLOCK');

export type Clock = { now(): Date };

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

// The seed run boots the api and the worker in one process on one stepped
// clock. The testing module's override is not in the production image, so
// the run hands its clock over here before either module is created.
let shared: Clock | undefined;

export function shareClock(c: Clock | undefined): void {
  shared = c;
}

export function processClock(): Clock {
  return shared ?? new SystemClock();
}

// Tests move time by hand so windows and sweeps are deterministic.
export class FixedClock implements Clock {
  constructor(private current: Date = new Date()) {}

  now(): Date {
    return new Date(this.current);
  }

  set(d: Date) {
    this.current = new Date(d);
  }

  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
}
