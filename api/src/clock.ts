export const CLOCK = Symbol('CLOCK');

export type Clock = { now(): Date };

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
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
