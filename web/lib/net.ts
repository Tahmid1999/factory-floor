// This is the visitor's Wi-Fi, simulated. While the on-screen switch is off or
// a scenario drop is on, netFetch throws NetworkDown before any request leaves
// the phone. A real dropout makes fetch throw a TypeError, which is turned into
// the same NetworkDown, so the queue, the sync loop and the gate cannot tell a
// simulated dropout from a real one.
//
// The network is kept per station. The trap is a story about two tables on one
// floor: QC's Wi-Fi drops while the sleeve table next to it stays online. On a
// real floor those are two devices; here one phone plays both, so the scenario
// drop marks only the station it names offline, and the manual switch marks
// every station offline, as turning off the phone's Wi-Fi would.

export class NetworkDown extends Error {
  constructor() {
    super('network down');
    this.name = 'NetworkDown';
  }
}

const SWITCH_KEY = 'ff-wifi-off';

// Kept for the tab, so a reload with scans still queued stays offline until
// the visitor turns the Wi-Fi back on. A new tab starts online and drains.
function readSwitch(): boolean {
  try {
    return typeof window === 'undefined' || window.sessionStorage.getItem(SWITCH_KEY) !== '1';
  } catch {
    return true;
  }
}

let wifiOn = readSwitch();
const drops = new Map<string, number>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') window.addEventListener('online', notify);

export function onNetChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function wifi(): boolean {
  return wifiOn;
}

export function setWifi(on: boolean) {
  wifiOn = on;
  try {
    if (on) window.sessionStorage.removeItem(SWITCH_KEY);
    else window.sessionStorage.setItem(SWITCH_KEY, '1');
  } catch {
    // Private mode: the switch just does not survive a reload.
  }
  notify();
}

export function dropFor(station: string, ms: number) {
  const until = Date.now() + ms;
  drops.set(station, until);
  notify();
  setTimeout(() => {
    if ((drops.get(station) ?? 0) <= Date.now()) {
      drops.delete(station);
      notify();
    }
  }, ms + 5);
}

// Milliseconds left on a scenario drop, for one station or for any of them.
export function dropLeft(station?: string): number {
  const now = Date.now();
  const untils = station ? [drops.get(station) ?? 0] : [...drops.values()];
  return Math.max(0, ...untils.map((u) => u - now));
}

export function offline(station: string): boolean {
  return !wifiOn || dropLeft(station) > 0;
}

export async function netFetch(url: string, init: RequestInit, station: string): Promise<Response> {
  if (offline(station)) throw new NetworkDown();
  try {
    return await fetch(url, { ...init, credentials: 'include' });
  } catch (e) {
    // A timeout belongs to the caller, which started it.
    if ((e as Error).name === 'AbortError') throw e;
    throw new NetworkDown();
  }
}
