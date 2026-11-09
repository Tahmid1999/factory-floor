import { mayScan } from './ownership';

const now = new Date();

describe('mayScan', () => {
  it('lets a guest scan their own bundle only', () => {
    expect(mayScan({ guestId: 'g1', sim: false }, { guestId: 'g1', isSimulated: false }, now)).toBe(true);
    expect(mayScan({ guestId: 'g1', sim: false }, { guestId: 'g2', isSimulated: false }, now)).toBe(false);
    expect(mayScan({ guestId: 'g1', sim: false }, { guestId: null, isSimulated: true }, now)).toBe(false);
  });

  it('lets the sim scan simulated bundles only', () => {
    expect(mayScan({ sim: true }, { guestId: null, isSimulated: true }, now)).toBe(true);
    expect(mayScan({ sim: true }, { guestId: 'g1', isSimulated: false }, now)).toBe(false);
  });
});
