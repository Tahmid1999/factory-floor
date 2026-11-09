import { labourMills, rateAt } from './rates';

const rates = [
  { id: 'a', styleId: 's', op: 'sew_collar', ratePerPieceMills: 15, effectiveFrom: new Date('2026-01-01T00:00:00Z') },
  { id: 'b', styleId: 's', op: 'sew_collar', ratePerPieceMills: 18, effectiveFrom: new Date('2026-11-10T00:00:00Z') },
];

describe('rateAt', () => {
  it('prices a scan before the change at the old rate', () => {
    expect(rateAt(rates, 's', 'sew_collar', new Date('2026-11-09T23:59:00Z'))).toBe(15);
  });
  it('prices a scan from the effective instant at the new rate', () => {
    expect(rateAt(rates, 's', 'sew_collar', new Date('2026-11-10T00:00:00Z'))).toBe(18);
  });
  it('throws when no rate is in force yet', () => {
    expect(() => rateAt(rates, 's', 'sew_collar', new Date('2025-12-31T00:00:00Z'))).toThrow();
  });
  it('throws for an op with no rate', () => {
    expect(() => rateAt(rates, 's', 'hem', new Date('2026-11-09T00:00:00Z'))).toThrow();
  });
});

describe('labourMills', () => {
  it('pays rate times pieces the first time', () => {
    expect(labourMills(15, 20, false)).toBe(300);
  });
  it('pays nothing when the step was already paid', () => {
    expect(labourMills(15, 20, true)).toBe(0);
  });
});
