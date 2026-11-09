import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Line 2 events' };

export default function HoodLayout({ children }: { children: React.ReactNode }) {
  return children;
}
