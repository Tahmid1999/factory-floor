'use client';

import { useEffect, useState } from 'react';
import { API } from '../../lib/api';

type HoodEvent = { t: number; kind: string; proc: string; text: string };

const KEEP = 200;

const time = (t: number) => new Date(t).toLocaleTimeString('en-GB');

// A bare list of what the line is doing, newest on top. EventSource resends
// the API's last 200 on every reconnect, so lines are keyed by time and text
// and a repeat is dropped.
export default function Hood() {
  const [rows, setRows] = useState<HoodEvent[]>([]);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const es = new EventSource(`${API}/events/stream`);
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data) as HoodEvent;
      setRows((cur) => {
        if (cur.some((c) => c.t === e.t && c.proc === e.proc && c.text === e.text)) return cur;
        return [e, ...cur].slice(0, KEEP);
      });
    };
    return () => es.close();
  }, []);

  return (
    <main className="hood mono" data-live={live}>
      {/* The same three fields the rows are deduplicated on, so the key is unique
          and a row keeps its node when a new line pushes it down. */}
      {rows.map((e) => (
        <div key={`${e.t}:${e.proc}:${e.text}`} data-kind={e.kind}>
          <span className="hood-t">{time(e.t)}</span> <span className="hood-p">{e.proc}</span> {e.text}
        </div>
      ))}
    </main>
  );
}
