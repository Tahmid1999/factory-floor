import type { HTMLAttributes } from 'react';

// Ant Design types onRow and onCell props as plain handlers; data attributes
// are what the e2e spec and the colour rules hang on.
export const attrs = (a: Record<string, string>) => a as unknown as HTMLAttributes<HTMLElement>;
