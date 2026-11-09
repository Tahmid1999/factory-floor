import { AntdRegistry } from '@ant-design/nextjs-registry';
import type { Metadata } from 'next';
import { Suspense } from 'react';
import './admin.css';
import { Shell } from './Shell';

export const metadata: Metadata = { title: 'Line 2 admin' };

// Ant Design loads only under /admin, so the phone station keeps its small bundle.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AntdRegistry>
      <Suspense>
        <Shell>{children}</Shell>
      </Suspense>
    </AntdRegistry>
  );
}
