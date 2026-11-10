import { cutTake, millsFor } from './stock';

describe('millsFor', () => {
  it('prices a bundle of fabric at 3400 a metre', () => {
    expect(millsFor(1800, 3400)).toBe(61_200);
  });

  it('rounds half away from zero on both sides', () => {
    expect(millsFor(1, 3250)).toBe(33);
    expect(millsFor(-1, 3250)).toBe(-33);
    expect(millsFor(1, 3240)).toBe(32);
    expect(millsFor(-1, 3240)).toBe(-32);
  });
});

describe('cutTake', () => {
  it('takes a bundle while at least a bundle would be left', () => {
    expect(cutTake(30_000)).toBe(1800);
    expect(cutTake(3600)).toBe(1800);
  });

  it('takes the whole remainder when less than a bundle would be left', () => {
    expect(cutTake(3000)).toBe(3000);
    expect(cutTake(3599)).toBe(3599);
    expect(cutTake(1800)).toBe(1800);
  });
});
