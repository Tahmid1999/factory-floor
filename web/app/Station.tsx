'use client';

import { useState } from 'react';
import { DEFECTS, ROUTE, STATION_CODES, STATIONS, StationCode, money, routeIndex } from '../lib/line';
import { dropLeft, offline, setWifi, wifi } from '../lib/net';
import { Flash } from './Flash';
import { Floor } from './useFloor';

const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB');

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <div className="row">
      <span>{k}</span>
      <span className={strong ? 'strong' : undefined} data-row={k}>
        {v}
      </span>
    </div>
  );
}

export function Station({ floor }: { floor: Floor }) {
  const { station, me } = floor;
  const [defect, setDefect] = useState<string>('collar');
  const [targetOp, setTargetOp] = useState<string>('sew_collar');
  const [busy, setBusy] = useState(false);

  const info = STATIONS[station];
  const asBatch = info.sewing || (station === 'Q-01' && me?.mode === 'async');
  const deviceId = floor.devices[station];
  const sync = deviceId ? floor.syncs[deviceId] : undefined;
  const next = floor.nextHere(station);

  // A scenario drop belongs to the trap; the switch waits until it is over.
  const scenario = dropLeft() > 0;
  const wifiLabel = scenario
    ? offline(station)
      ? 'wifi: dropped (scenario)'
      : 'wifi on'
    : wifi()
      ? 'wifi on'
      : 'wifi off';

  const pieces = floor.work.length * 20;
  const earned = floor.work.reduce((s, w) => s + w.mills, 0);

  async function scan(action?: 'qc_fail' | 'scrap') {
    if (!next) {
      floor.setFlash({ tone: 'idle', title: 'no bundle', detail: `nothing waiting at ${station}` });
      return;
    }
    setBusy(true);
    try {
      if (asBatch) await floor.batchScan(station, next.code, info.sewing ? info.op : 'qc_flag');
      else if (station === 'Q-01') await floor.gate(station, 'qc_flag', next.code, { defect });
      else if (station === 'Q-02') await floor.gate(station, action ?? 'qc_pass', next.code, { defect });
      else await floor.gate(station, action ?? 'clear_rework', next.code, { targetOp });
    } finally {
      setBusy(false);
    }
  }

  // Back to any step already done on this bundle, from the collar on.
  const backTo =
    station === 'SUP' && next ? ROUTE.filter((op, i) => i >= 1 && i < Math.max(2, routeIndex(next.nextOp))) : [];

  return (
    <div className="station">
      <div className="top mono">
        <span data-testid="station">
          {station} · {info.label}
        </span>
        <button
          className={`sw${wifiLabel === 'wifi on' ? '' : ' sw-off'}`}
          disabled={scenario}
          onClick={() => setWifi(!wifi())}
        >
          {wifiLabel}
        </button>
      </div>

      <Flash flash={floor.flash} />

      {asBatch ? (
        <>
          <Row k="pending" v={String(sync?.pending ?? 0)} strong={(sync?.pending ?? 0) > 0} />
          {sync?.retry ? (
            <Row
              k="next retry"
              v={`in ${Math.max(0, Math.ceil((sync.retry.at - Date.now()) / 1000))} s (try ${sync.retry.tryNo})`}
            />
          ) : (
            <Row
              k="last sync"
              v={sync?.last ? `${clock(sync.last.at)} · ${sync.last.events} events · ${sync.last.http}` : '-'}
            />
          )}
          {sync && sync.pending > 0 && <Row k="queue" v={`IndexedDB · seq ${sync.firstSeq}-${sync.lastSeq}`} />}
        </>
      ) : (
        <Row k="check" v={floor.gateCheck ?? '-'} />
      )}
      {floor.resyncInfo?.station === station && (
        <>
          <Row
            k="queue"
            v={`dropped ${floor.resyncInfo.dropped} · refetched ${floor.resyncInfo.codes.join(', ')}`}
          />
          {floor.resyncInfo.avoidedMills > 0 && (
            <Row k="waste avoided" v={`${money(floor.resyncInfo.avoidedMills)} labour and trims`} />
          )}
        </>
      )}
      <Row k="my pieces today" v={`${pieces} · ${money(earned)}`} />

      {(station === 'Q-01' && !asBatch) || station === 'Q-02' ? (
        <label className="pick">
          defect
          <select value={defect} onChange={(e) => setDefect(e.target.value)}>
            {DEFECTS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
      ) : null}
      {station === 'SUP' && backTo.length > 0 ? (
        <label className="pick">
          send back to
          <select value={targetOp} onChange={(e) => setTargetOp(e.target.value)}>
            {backTo.map((op) => (
              <option key={op}>{op}</option>
            ))}
          </select>
        </label>
      ) : null}

      <button className="btn" disabled={busy || !me || !deviceId} onClick={() => void scan()}>
        Scan next bundle
      </button>
      {station === 'Q-02' && (
        <button className="btn btn-quiet" disabled={busy || !deviceId} onClick={() => void scan('qc_fail')}>
          Fail with defect
        </button>
      )}
      {station === 'SUP' && (
        <button className="btn btn-quiet" disabled={busy || !deviceId} onClick={() => void scan('scrap')}>
          Scrap it
        </button>
      )}
      <p className="hint">
        {next ? `next here: ${next.code}` : `nothing waiting at ${station}`}
        {info.sewing ? ' · tap = laser scan' : ' · gate scans never queue'}
      </p>

      <div className="picker" role="group" aria-label="station">
        {STATION_CODES.map((s: StationCode) => (
          <button key={s} className={s === station ? 'on' : undefined} onClick={() => floor.setStation(s)}>
            {s}
          </button>
        ))}
      </div>

      {floor.log.length > 0 && (
        <ul className="log mono" aria-label="log">
          {floor.log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
