import { Logger } from '@nestjs/common';
import { FixedClock } from '../clock';
import { SimService } from './sim.service';

describe('SimService when the api cannot be reached', () => {
  afterEach(() => jest.restoreAllMocks());

  it('says so once a minute, not on every tick', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const clock = new FixedClock(new Date('2026-11-09T10:00:00Z'));
    const sim = new SimService(
      {
        // Nothing listens on port 1, so every call fails at once.
        baseUrl: 'http://127.0.0.1:1',
        key: 'k',
        tickMs: 1000,
        movesPerTick: 1,
        random: () => 0.5,
        offlineChance: 0,
        offlineMs: [1, 1],
        flagChance: 0,
        failChance: 0,
        clearAfterMs: 60_000,
        collarTarget: 6,
      },
      clock,
    );
    const lines = () => warn.mock.calls.filter(([m]) => String(m).startsWith('sim register failed')).length;

    for (let i = 0; i < 5; i++) await sim.tick();
    expect(lines()).toBe(1);
    clock.advance(61_000);
    await sim.tick();
    expect(lines()).toBe(2);
  });
});
