import { hit } from './limits';

describe('hit', () => {
  it('allows 5 in a window and refuses the 6th', () => {
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(hit('k-a', 5, 60, t + i)).toBe(true);
    expect(hit('k-a', 5, 60, t + 10)).toBe(false);
  });

  it('allows again once the window has passed', () => {
    const t = 2_000_000;
    for (let i = 0; i < 5; i++) hit('k-b', 5, 60, t);
    expect(hit('k-b', 5, 60, t + 1000)).toBe(false);
    expect(hit('k-b', 5, 60, t + 60_000)).toBe(true);
  });

  it('counts keys separately', () => {
    const t = 3_000_000;
    for (let i = 0; i < 5; i++) hit('k-c', 5, 60, t);
    expect(hit('k-d', 5, 60, t)).toBe(true);
  });
});
