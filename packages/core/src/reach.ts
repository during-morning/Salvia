import { EventEmitter } from 'node:events';
import { UA, proxiedFetch } from './http.ts';
import { registry } from './registry.ts';

/**
 * Whether sites answer from this network, checked once at start-up (and again on demand). Until a
 * check finishes a site counts as reachable. Through @proxy when one is set for the site. The
 * probe URLs come from the modules (registry `site`).
 */

const state = new Map<string, boolean>();
const pending = new Map<string, Promise<boolean>>();
export const reachEvents = new EventEmitter<{ change: [site: string, ok: boolean] }>();

export function probe(site: string, timeout = 6000): Promise<boolean> {
  const url = registry.sites.get(site)?.probe;
  if (!url) return Promise.resolve(true);
  let p = pending.get(site);
  if (!p) {
    p = proxiedFetch(url, { method: 'GET', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(timeout) })
      .then(
        async (res) => {
          await res.body?.cancel();
          return res.status < 500;
        },
        () => false,
      )
      .then((ok) => {
        pending.delete(site);
        if (state.get(site) !== ok) {
          state.set(site, ok);
          reachEvents.emit('change', site, ok);
        }
        return ok;
      });
    pending.set(site, p);
  }
  return p;
}

export function probeAll(): Promise<boolean[]> {
  return Promise.all([...registry.sites.values()].filter((s) => s.probe).map((s) => probe(s.id)));
}

/** Last known answer (true until checked). */
export function reachable(site: string): boolean {
  return state.get(site) ?? true;
}

/** Checked and found unreachable. */
export function unreachable(site: string): boolean {
  return state.get(site) === false;
}

/** For tests. */
export function setReachable(site: string, ok: boolean | undefined): void {
  if (ok === undefined) state.delete(site);
  else state.set(site, ok);
}
