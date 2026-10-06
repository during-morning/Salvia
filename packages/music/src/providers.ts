import { getSetting, provided, registry, slot, unreachable } from '@salvia/core';
import type { AudioMatcher, MusicProvider, Track } from './model.ts';

/** Music platforms (filled by platform modules). */
export const MUSIC_PROVIDERS = slot<MusicProvider>('music.provider');
/** Video sites that can stand in for metadata-only platforms' audio. */
export const AUDIO_MATCHERS = slot<AudioMatcher>('music.matcher');

export const providers = (): MusicProvider[] => provided(MUSIC_PROVIDERS);
export const matchers = (): AudioMatcher[] => provided(AUDIO_MATCHERS);

export const providerOf = (source: string): MusicProvider | undefined => providers().find((p) => p.source === source);

/** The provider behind `@music:<id>`. */
export const byPlatform = (id: string): MusicProvider | undefined => providers().find((p) => (p.platform ?? p.source) === id);

/** Its network answers (or hasn't been found not to). */
export const reachableProvider = (p: MusicProvider): boolean => !p.site || !unreachable(p.site);

/** Only answers mainland-China networks (registry site region). */
export const mainlandOnly = (p: MusicProvider): boolean => !!p.site && registry.sites.get(p.site)?.region === 'cn';

export const matchOnly = (t: Track): boolean => !!providerOf(t.source)?.matchOnly;

/** A track's fuller details from its platform (album, cover, release), or the track as is. */
export async function enrich(t: Track, signal?: AbortSignal): Promise<Track> {
  const p = providerOf(t.source);
  if (!p?.details) return t;
  return (await p.details(t, signal).catch(() => undefined)) ?? t;
}

/**
 * The providers a search asks: the one named (`@music:<id>`, or its stand-in when unreachable),
 * or every default one (all with `@music:all` / the musicSearch setting) that can search. Those
 * whose network is known to be unreachable are left out and reported.
 */
export function searchProviders(platform?: string): { list: MusicProvider[]; skipped: MusicProvider[] } {
  if (platform && platform !== 'all') {
    const p = byPlatform(platform);
    if (!p) return { list: [], skipped: [] };
    if (!reachableProvider(p) && p.standIn) {
      const stand = providerOf(p.standIn);
      if (stand) return { list: [stand], skipped: [p] };
    }
    return { list: [p], skipped: [] };
  }
  const all = platform === 'all' || getSetting('musicSearch') === 'all';
  const wanted = providers().filter((p) => (all || p.defaultSearch) && p.searchable?.() !== false);
  return { list: wanted.filter(reachableProvider), skipped: wanted.filter((p) => !reachableProvider(p)) };
}
