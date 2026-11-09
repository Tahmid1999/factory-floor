'use client';

import { Button, Input } from 'antd';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { adminCall } from '../../../lib/admin';
import { useAdminSession } from '../session';

export default function LoginPage() {
  const router = useRouter();
  const { reload } = useAdminSession();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await adminCall('/admin/login', { method: 'POST', body: JSON.stringify({ login, password }) });
      reload();
      router.push('/admin');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} style={{ maxWidth: 280, display: 'grid', gap: 8 }}>
      <b>Admin login</b>
      <Input size="small" placeholder="login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
      <Input.Password
        size="small"
        placeholder="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <Button size="small" type="primary" htmlType="submit" loading={busy} disabled={!login || !password}>
        Log in
      </Button>
      {error && <span className="adm-bad mono">{error}</span>}
    </form>
  );
}
