import type { Quality, Track } from './model.ts';
import { providers, reachableProvider } from './providers.ts';

/** Lower case without spaces and punctuation, for comparing names across platforms. */
export const norm = (s: string) => s.toLowerCase().replace(/[\s·・,，。.:：!！?？()（）[\]【】《》"'“”‘’—\-_/]/g, '');

const artistKeys = (t: Pick<Track, 'artists'>) => t.artists.flatMap((a) => a.split(/[/、,，&]/)).map(norm).filter(Boolean);

/** Same song: title and artists identical once punctuation and case are ignored, durations within 3 s. */
export function exactSame(a: Pick<Track, 'title' | 'artists' | 'duration'>, b: Pick<Track, 'title' | 'artists' | 'duration'>): boolean {
  const title = norm(a.title);
  if (!title || title !== norm(b.title)) return false;
  const [x, y] = [artistKeys(a), artistKeys(b)];
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!short.every((k) => long.includes(k))) return false;
  return !(a.duration && b.duration && Math.abs(a.duration - b.duration) > 3);
}

export type ExactHit = { track: Track; qualities: Quality[] };

/**
 * Lookups are shared: a batch of fifty songs from one album asks each platform once per song, at
 * most three songs at a time, and a song looked up in the last ten minutes isn't asked again.
 */
const TTL_MS = 10 * 60_000;
const MAX_ACTIVE = 3;
const cache = new Map<string, { at: number; hit: Promise<ExactHit | undefined> }>();
let active = 0;
const waiting: (() => void)[] = [];

async function turn(): Promise<() => void> {
  if (active >= MAX_ACTIVE) await new Promise<void>((r) => waiting.push(r));
  active++;
  return () => {
    active--;
    waiting.shift()?.();
  };
}

async function lookup(t: Track, skip: string): Promise<ExactHit | undefined> {
  const done = await turn();
  try {
    const signal = AbortSignal.timeout(15_000);
    const asked = providers()
      .filter((p) => p.exactRank !== undefined && p.source !== t.source && p.source !== skip && p.qualities && reachableProvider(p))
      .sort((a, b) => a.exactRank! - b.exactRank!);
    const query = `${t.title} ${t.artists[0] ?? ''}`.trim();
    const found = await Promise.all(
      asked.map((p) =>
        p.search(query, signal).then(
          (hits) => hits.filter((h) => h.playable !== false && exactSame(t, h)).slice(0, 2),
          () => [] as Track[],
        ),
      ),
    );
    for (const [i, hits] of found.entries()) {
      for (const hit of hits) {
        const qs = (await asked[i]!.qualities!(hit, signal).catch(() => [] as Quality[])).filter((q) => !q.trial);
        if (qs.length) return { track: hit, qualities: qs };
      }
    }
    return undefined;
  } finally {
    done();
  }
}

/** The same song (exactSame) on another reachable platform that has a downloadable file for it. */
export function exactMatch(t: Track, skip = ''): Promise<ExactHit | undefined> {
  const key = [norm(t.title), artistKeys(t).join(','), t.duration ?? '', t.source, skip].join('|');
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > TTL_MS) cache.delete(k);
  let entry = cache.get(key);
  if (!entry) {
    entry = { at: now, hit: lookup(t, skip).catch(() => undefined) };
    cache.set(key, entry);
  }
  return entry.hit;
}
