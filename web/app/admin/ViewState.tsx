'use client';

import type { ReactNode } from 'react';
import { Polled } from '../../lib/admin';

// What a page shows before it has rows: the API's own refusal text for a view
// the role may not read, or a plain line while loading or when the API is down.
export function ViewState<T>({ poll, children }: { poll: Polled<T>; children: (data: T) => ReactNode }) {
  if (poll.error) {
    return (
      <div className="adm-err mono" data-testid="view-error">
        {poll.error.message}
      </div>
    );
  }
  if (!poll.data) return <div className="adm-mute mono">{poll.offline ? 'api unreachable' : 'loading'}</div>;
  return (
    <>
      {poll.offline && <div className="adm-warn mono">api unreachable, showing the last read</div>}
      {children(poll.data)}
    </>
  );
}
