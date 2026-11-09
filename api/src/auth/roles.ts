import { SetMetadata } from '@nestjs/common';

export const ROLES = ['operator', 'qc', 'storekeeper', 'supervisor', 'accounts', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type AdminView = 'floor' | 'bundles' | 'held' | 'stations' | 'audit' | 'payroll' | 'pnl' | 'stock';

const ALL_VIEWS: AdminView[] = ['floor', 'bundles', 'held', 'stations', 'audit', 'payroll', 'pnl', 'stock'];

export const READS: Record<Role, AdminView[]> = {
  operator: ['floor'],
  qc: ['floor', 'bundles'],
  storekeeper: ['stock'],
  supervisor: ['floor', 'bundles', 'held', 'stations'],
  accounts: ['payroll', 'pnl', 'audit'],
  admin: ALL_VIEWS,
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export const READS_KEY = 'ff:reads';
export const WRITES_KEY = 'ff:writes';

// Declared next to the route, so what a role may see is read off the
// controller and not kept in a second table that can drift.
export const Reads = (view: AdminView) => SetMetadata(READS_KEY, view);
export const Writes = () => SetMetadata(WRITES_KEY, true);
