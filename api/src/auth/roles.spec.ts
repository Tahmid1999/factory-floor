import { AdminView, READS, ROLES } from './roles';

const VIEWS: AdminView[] = ['floor', 'bundles', 'held', 'stations', 'audit', 'payroll', 'pnl', 'stock'];

describe('READS', () => {
  it('lets the storekeeper read stock and not floor', () => {
    expect(READS.storekeeper).toContain('stock');
    expect(READS.storekeeper).not.toContain('floor');
  });

  it('lets admin read every view', () => {
    expect([...READS.admin].sort()).toEqual([...VIEWS].sort());
  });

  it('keeps accounts away from the floor views', () => {
    expect([...READS.accounts].sort()).toEqual(['audit', 'payroll', 'pnl']);
  });

  it('defines every role', () => {
    expect(Object.keys(READS).sort()).toEqual([...ROLES].sort());
  });
});
