import { nextPeriod, periodBounds, periodOf } from './period';

describe('period', () => {
  it('takes the month in UTC, not local time', () => {
    expect(periodOf(new Date('2026-10-31T23:59:59.999Z'))).toBe('2026-10');
    expect(periodOf(new Date('2026-11-01T00:00:00.000Z'))).toBe('2026-11');
  });

  it('rolls the year over', () => {
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(nextPeriod('2026-09')).toBe('2026-10');
  });

  it('bounds a month at the start of the next, including at year end', () => {
    expect(periodBounds('2026-12')).toEqual({
      start: new Date('2026-12-01T00:00:00Z'),
      end: new Date('2027-01-01T00:00:00Z'),
    });
    expect(periodBounds('2026-02').end).toEqual(new Date('2026-03-01T00:00:00Z'));
  });
});
