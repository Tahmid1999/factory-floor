'use client';

import { useSearchParams } from 'next/navigation';
import { Role, isRole, withAs } from '../../lib/admin';

// The role being viewed lives in the URL, so a shared link shows the same view.
export function useAs() {
  const raw = useSearchParams().get('as');
  const as: Role | null = isRole(raw) ? raw : null;
  return {
    as,
    // An internal link that keeps the role.
    href: (path: string) => withAs(path, as),
    // An API path that asks as that role.
    api: (path: string) => withAs(path, as),
  };
}
