import { mayScan } from './ownership';

const now = new Date('2026-11-09T10:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

// On the polo route nextStep 1 is sew_collar, 2 sew_sleeve, 3 side_seam,
// 5 qc_final, 6 pack and 7 ship.
const guestBundle = (over: Partial<Parameters<typeof mayScan>[1]> = {}) => ({
  guestId: 'g1',
  isSimulated: false,
  status: 'active' as Parameters<typeof mayScan>[1]['status'],
  nextStep: 1,
  guestLastActiveAt: minutesAgo(1) as Date | null,
  ...over,
});

describe('mayScan', () => {
  it('lets a guest scan their own bundle only', () => {
    expect(mayScan({ guestId: 'g1', sim: false }, guestBundle(), now)).toBe(true);
    expect(mayScan({ guestId: 'g1', sim: false }, guestBundle({ guestId: 'g2' }), now)).toBe(false);
    expect(mayScan({ guestId: 'g1', sim: false }, guestBundle({ guestId: null, isSimulated: true }), now)).toBe(false);
  });

  it('lets the sim scan its own bundles', () => {
    expect(mayScan({ sim: true }, guestBundle({ guestId: null, isSimulated: true, guestLastActiveAt: null }), now)).toBe(true);
  });

  it('keeps the sim off the bundle of a guest who is still here', () => {
    expect(mayScan({ sim: true }, guestBundle({ nextStep: 2 }), now)).toBe(false);
  });

  it('lets the sim carry a guest bundle once the guest has been quiet for 5 minutes', () => {
    expect(mayScan({ sim: true }, guestBundle({ guestLastActiveAt: minutesAgo(5) }), now)).toBe(true);
    expect(mayScan({ sim: true }, guestBundle({ guestLastActiveAt: minutesAgo(4.9) }), now)).toBe(false);
  });

  it('lets the sim only pack and ship the bundle of a guest who is still here', () => {
    expect(mayScan({ sim: true }, guestBundle({ nextStep: 3 }), now)).toBe(false);
    expect(mayScan({ sim: true }, guestBundle({ nextStep: 5 }), now)).toBe(false);
    expect(mayScan({ sim: true }, guestBundle({ nextStep: 6 }), now)).toBe(true);
    expect(mayScan({ sim: true }, guestBundle({ status: 'packed', nextStep: 7 }), now)).toBe(true);
  });

  it('never lets the sim flag or clear the bundle of a guest who is still here', () => {
    expect(mayScan({ sim: true }, guestBundle({ status: 'rework', nextStep: 3 }), now)).toBe(false);
    expect(mayScan({ sim: true }, guestBundle({ status: 'rework', nextStep: 6 }), now)).toBe(false);
    expect(mayScan({ sim: true }, guestBundle({ status: 'rework', guestLastActiveAt: minutesAgo(5) }), now)).toBe(true);
  });

  it('never lets a guest scan the bundle of another guest, quiet or not', () => {
    const b = guestBundle({ guestId: 'g2', guestLastActiveAt: minutesAgo(60), nextStep: 5 });
    expect(mayScan({ guestId: 'g1', sim: false }, b, now)).toBe(false);
  });
});
