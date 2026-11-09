import { BundleStatus } from '@prisma/client';

export type Decision =
  | { kind: 'apply' }
  | { kind: 'duplicate' }
  | { kind: 'hold' }
  | { kind: 'reject'; reason: 'rework' | 'scrapped' | 'finished' | 'unknown-op' };

type BundleState = { status: BundleStatus; nextStep: number; route: string[]; reworkRound: number };

export function decide(
  b: BundleState,
  op: string,
  done: { op: string; round: number }[],
): Decision {
  if (b.status === 'rework') return { kind: 'reject', reason: 'rework' };
  if (b.status === 'scrapped') return { kind: 'reject', reason: 'scrapped' };

  const at = b.route.indexOf(op);
  if (at === -1) return { kind: 'reject', reason: 'unknown-op' };

  if (done.some((d) => d.op === op && d.round === b.reworkRound)) return { kind: 'duplicate' };

  if (b.status === 'packed' || b.status === 'shipped') {
    return at === b.nextStep ? { kind: 'apply' } : { kind: 'reject', reason: 'finished' };
  }

  if (at === b.nextStep) return { kind: 'apply' };
  if (at > b.nextStep) return { kind: 'hold' };
  // An earlier step not done this round is a replay from before the rollback.
  return { kind: 'duplicate' };
}

// Inline QC may flag only between the first sewing step and the final check.
export function canFlag(b: BundleState): boolean {
  if (b.status !== 'active') return false;
  const first = b.route.indexOf('sew_collar');
  const final = b.route.indexOf('qc_final');
  return b.nextStep > first && b.nextStep <= final;
}

export function rollBackTo(route: string[], targetOp: string): number {
  const at = route.indexOf(targetOp);
  if (at === -1) throw new Error(`op ${targetOp} is not on the route`);
  return at;
}
