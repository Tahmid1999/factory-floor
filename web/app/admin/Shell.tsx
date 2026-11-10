'use client';

import { Menu } from 'antd';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Role, ROLES, READS, View, adminCall, isRole, useSession } from '../../lib/admin';
import { SessionContext } from './session';
import { useAs } from './useAs';

const LIVE: { view: View; label: string; path: string }[] = [
  { view: 'floor', label: 'Floor', path: '/admin' },
  { view: 'bundles', label: 'Bundles', path: '/admin/bundles' },
  { view: 'held', label: 'Held', path: '/admin/held' },
  { view: 'stations', label: 'Stations', path: '/admin/stations' },
  { view: 'payroll', label: 'Payroll', path: '/admin/payroll' },
  { view: 'pnl', label: 'Month P&L', path: '/admin/pnl' },
  { view: 'stock', label: 'Stock', path: '/admin/stock' },
  { view: 'audit', label: 'Audit', path: '/admin/audit' },
];

export function Shell({ children }: { children: React.ReactNode }) {
  const { as, href } = useAs();
  const pathname = usePathname();
  const router = useRouter();
  const { session, reload } = useSession();
  const role: Role = as ?? 'admin';

  // The floor owns the bare /admin path, so it only matches when nothing longer does.
  const selected = LIVE.find((i) => i.path !== '/admin' && pathname.startsWith(i.path)) ?? LIVE[0];
  const items = [
    ...LIVE.filter((i) => READS[role].includes(i.view)).map((i) => ({
      key: i.path,
      label: <Link href={href(i.path)}>{i.label}</Link>,
    })),
  ];

  const pick = (value: string) => {
    if (!isRole(value)) return;
    const next = new URLSearchParams(window.location.search);
    if (value === 'admin') next.delete('as');
    else next.set('as', value);
    const q = next.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  };

  const logout = async () => {
    await adminCall('/admin/logout', { method: 'POST' }).catch(() => undefined);
    reload();
  };

  return (
    <div className="adm-shell">
      <nav className="adm-side" aria-label="views">
        <Menu mode="inline" selectedKeys={[selected.path]} items={items} />
      </nav>
      <div className="adm-main">
        <header className="adm-head">
          <span>
            <label htmlFor="view-as">view as</label>
            <select id="view-as" aria-label="view as" value={role} onChange={(e) => pick(e.target.value)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </span>
          <span className="adm-mute">
            {session === undefined ? null : session ? (
              <>
                <span className="mono">{session.login}</span> ·{' '}
                <a
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    logout();
                  }}
                >
                  Log out
                </a>
              </>
            ) : (
              <Link href="/admin/login">Admin login</Link>
            )}
          </span>
        </header>
        <SessionContext.Provider value={{ session: session ?? null, reload }}>{children}</SessionContext.Provider>
      </div>
    </div>
  );
}
