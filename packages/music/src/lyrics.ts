import { rank } from './match.ts';
import { artistLine, type Lyrics, type Track } from './model.ts';
import { providerOf, providers, reachableProvider } from './providers.ts';

/** Lyrics from the track's own platform, else the best match on a lyrics-fallback platform. */
export async function findLyrics(t: Track, signal?: AbortSignal): Promise<Lyrics | undefined> {
  try {
    const own = providerOf(t.source);
    if (own?.lyrics) {
      const l = await own.lyrics(t, signal).catch(() => undefined);
      // A release without lyrics has none; metadata-only tracks and video uploads look elsewhere.
      if (l || (!own.matchOnly && !own.video)) return l;
    }
    for (const p of providers().filter((x) => x.lyricsFallback && x.lyrics && x !== own && reachableProvider(x))) {
      const hits = await p.search(`${t.title} ${t.artists[0] ?? ''}`, signal).catch(() => [] as Track[]);
      const best = rank(
        t,
        hits.map((h) => ({ id: h.id, title: h.title, channel: artistLine(h), duration: h.duration })),
      )[0];
      if (!best || best.score < 70) continue;
      const l = await p.lyrics!({ ...t, id: best.candidate.id, source: p.source }, signal).catch(() => undefined);
      if (l) return l;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** LRC → plain lines: time tags and metadata dropped, blank runs collapsed. */
export function plainLyrics(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .filter((l) => !/^\s*\{.*\}\s*$/.test(l)) // NetEase's JSON credit lines
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
