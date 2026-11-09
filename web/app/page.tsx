'use client';

import { Station } from './Station';
import { TrapCard } from './TrapCard';
import { useFloor } from './useFloor';

export default function Page() {
  const floor = useFloor();

  return (
    <main className="wrap">
      <div className="phone">
        <p className="who mono">
          {floor.me ? `${floor.me.name} · line 2 · style 944 polo` : (floor.bootError ?? 'opening the station')}
        </p>
        <Station floor={floor} />
        <TrapCard floor={floor} />
      </div>
      <aside className="about">
        <p>
          Your phone is now a scan station on a sewing line. Sewing scans go green at once and wait in IndexedDB
          until the network takes them, so a dead access point never stops a sewer.
        </p>
        <p>
          QC is the one place I made a live call instead. Run the trap in both modes to see what a rework flag
          stuck in a queue costs.
        </p>
      </aside>
    </main>
  );
}
