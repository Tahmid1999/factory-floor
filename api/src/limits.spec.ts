import { allow, hit, stressRefusal, windowCount } from './limits';

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

  it('forgets windows that have run out, so new keys do not pile up', () => {
    const t = 4_000_000;
    for (let i = 0; i < 3000; i++) hit(`k-old-${i}`, 5, 60, t);
    expect(windowCount()).toBeGreaterThanOrEqual(3000);
    // A minute on, the next sweep drops every one of them.
    for (let i = 0; i < 1000; i++) hit('k-new', 5000, 60, t + 60_000);
    expect(windowCount()).toBeLessThan(100);
    expect(hit('k-new', 5000, 60, t + 60_000)).toBe(true);
  });
});

describe('stressRefusal', () => {
  it('gives one address one run a minute', () => {
    const t = 5_000_000;
    expect(stressRefusal('192.0.2.1', t)).toBeNull();
    expect(stressRefusal('192.0.2.1', t + 59_000)).toEqual(expect.any(String));
    expect(stressRefusal('192.0.2.1', t + 60_000)).toBeNull();
  });

  it('stops everyone after 20 runs in an hour', () => {
    const t = 9_000_000;
    // The total window is shared, so this starts after the runs above have aged out.
    for (let i = 0; i < 20; i++) expect(stressRefusal(`198.51.100.${i}`, t + i)).toBeNull();
    expect(stressRefusal('198.51.100.200', t + 100)).toEqual(expect.any(String));
    expect(stressRefusal('198.51.100.201', t + 3_600_000)).toBeNull();
  });
});

describe('allow', () => {
  afterEach(() => {
    delete process.env.SEED_MODE;
  });

  it('is the same fixed window as hit', () => {
    const t = 7_000_000;
    expect(allow('k-e', 2, 1, t)).toBe(true);
    expect(allow('k-e', 2, 1, t)).toBe(true);
    expect(allow('k-e', 2, 1, t)).toBe(false);
  });

  it('lets everything through in a seed run, and leaves hit alone', () => {
    process.env.SEED_MODE = '1';
    const t = 8_000_000;
    for (let i = 0; i < 100; i++) expect(allow('k-f', 2, 1, t)).toBe(true);
    expect(hit('k-g', 1, 60, t)).toBe(true);
    expect(hit('k-g', 1, 60, t)).toBe(false);
  });
});
