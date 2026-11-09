import { canFlag, decide, rollBackTo } from './state-machine';
import { POLO_ROUTE } from './line';

const fresh = { status: 'active' as const, nextStep: 1, route: POLO_ROUTE, reworkRound: 0 };
const cutDone = [{ op: 'cut', round: 0 }];

describe('decide', () => {
  it('applies the next step, holds a later one, treats an earlier one as a replay', () => {
    expect(decide(fresh, 'sew_collar', cutDone)).toEqual({ kind: 'apply' });
    expect(decide(fresh, 'sew_sleeve', cutDone)).toEqual({ kind: 'hold' });
    expect(decide(fresh, 'cut', cutDone)).toEqual({ kind: 'duplicate' });
  });

  it('rejects any op on a bundle in rework or scrapped', () => {
    expect(decide({ ...fresh, status: 'rework' }, 'sew_collar', cutDone)).toEqual({ kind: 'reject', reason: 'rework' });
    expect(decide({ ...fresh, status: 'scrapped' }, 'sew_collar', cutDone)).toEqual({ kind: 'reject', reason: 'scrapped' });
  });

  it('rejects an op that is not on the route', () => {
    expect(decide(fresh, 'dye', cutDone)).toEqual({ kind: 'reject', reason: 'unknown-op' });
  });

  it('re-applies a step done in an earlier round, but not twice in the same round', () => {
    const afterRollback = { ...fresh, nextStep: 1, reworkRound: 1 };
    const done = [
      { op: 'cut', round: 0 },
      { op: 'sew_collar', round: 0 },
      { op: 'sew_sleeve', round: 0 },
    ];
    expect(decide(afterRollback, 'sew_collar', done)).toEqual({ kind: 'apply' });
    const repeated = [...done, { op: 'sew_collar', round: 1 }];
    expect(decide({ ...afterRollback, nextStep: 2 }, 'sew_collar', repeated)).toEqual({ kind: 'duplicate' });
  });

  it('rejects everything but the next op on a packed or shipped bundle', () => {
    const packed = { status: 'packed' as const, nextStep: 7, route: POLO_ROUTE, reworkRound: 0 };
    expect(decide(packed, 'ship', [])).toEqual({ kind: 'apply' });
    expect(decide(packed, 'hem', [])).toEqual({ kind: 'reject', reason: 'finished' });
    const shipped = { ...packed, status: 'shipped' as const, nextStep: 8 };
    expect(decide(shipped, 'ship', [{ op: 'ship', round: 0 }])).toEqual({ kind: 'duplicate' });
    expect(decide(shipped, 'pack', [])).toEqual({ kind: 'reject', reason: 'finished' });
  });
});

describe('canFlag', () => {
  const at = (nextStep: number, status: 'active' | 'rework' = 'active') => ({
    status,
    nextStep,
    route: POLO_ROUTE,
    reworkRound: 0,
  });
  it('is false before sew_collar is done', () => {
    expect(canFlag(at(1))).toBe(false);
  });
  it('is true between sew_collar and qc_final', () => {
    expect(canFlag(at(2))).toBe(true);
    expect(canFlag(at(5))).toBe(true);
  });
  it('is false once qc_final is done, or when not active', () => {
    expect(canFlag(at(6))).toBe(false);
    expect(canFlag(at(3, 'rework'))).toBe(false);
  });
});

describe('rollBackTo', () => {
  it('returns the index of the op', () => {
    expect(rollBackTo(POLO_ROUTE, 'sew_collar')).toBe(1);
  });
  it('throws on an op outside the route', () => {
    expect(() => rollBackTo(POLO_ROUTE, 'dye')).toThrow();
  });
});
